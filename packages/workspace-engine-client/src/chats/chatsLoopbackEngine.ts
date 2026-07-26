import { createHash } from "node:crypto";
import type { Event } from "../ydoc/generated/Event";
import type { JsonValue } from "../ydoc/generated/serde_json/JsonValue";
import type { Request } from "../ydoc/generated/Request";
import type { Response } from "../ydoc/generated/Response";
import type { EngineTransport } from "../ydoc/ydocLiveAdapter";
import {
  CHATS_METHOD,
  type ChatActor,
  type ChatAgentReadState,
  type ChatAttachment,
  type ChatBookmark,
  type ChatChannel,
  type ChatDecision,
  type ChatDispatch,
  type ChatDispatchClaim,
  type ChatFeedReadState,
  type ChatFeedItem,
  type ChatFollow,
  type ChatLocalAttachmentParams,
  type ChatMention,
  type ChatMessage,
  type ChatProjectionFileAccess,
  type ChatReaction,
  type ChatRun,
  type ChatsJsonObject,
  type ChatThread,
  type ChatThreadPause,
  type ChatThreadReadState,
} from "./chatsWireContract";

const INBAND_CONTENT_CAP_BYTES = 48 * 1024;
const MAX_PAGE_LIMIT = 500;
const DEFAULT_PAGE_LIMIT = 200;
const APP_QUIT_EXIT_CODE = 143;

interface WorkspaceState {
  channels: Map<string, ChatChannel & { wireId: string | null }>;
  threads: Map<string, ChatThread>;
  messages: Map<string, ChatMessage>;
  threadMessages: Map<string, string[]>;
  attachments: Map<string, ChatAttachment>;
  decisions: Map<string, ChatDecision>;
  reactions: Map<string, ChatReaction>;
  mentions: ChatMention[];
  agentReads: Map<string, ChatAgentReadState>;
  humanReads: Map<string, number>;
  humanReadStates: Map<string, ChatThreadReadState>;
  follows: Map<string, Set<string>>;
  followRecords: Map<string, ChatFollow>;
  feedReads: Map<string, ChatFeedReadState>;
  bookmarks: Map<string, ChatBookmark>;
  dispatches: Map<string, ChatDispatch>;
  runs: Map<string, ChatRun>;
  runLinks: Map<string, string>;
  pauses: Map<string, ChatThreadPause>;
  scanHighWaterMs: number;
}

type SeedChannelInput = {
  workspace: string;
  channelId: string;
  name: string;
  kind?: "channel" | "dm" | "agent";
  wireId?: string | null;
  createdAtMs?: number;
};

type SeedBookmarkInput = {
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
  createdAtMs?: number;
  updatedAtMs?: number;
  generation?: number;
  projectedGeneration?: number;
  projectionState?: ChatBookmark["projectionState"];
  projectionObjectId?: string;
  lastProjectedAtMs?: number;
  failureReason?: string;
};

type SeedDispatchInput = {
  workspaceId: string;
  triggerMessageId: string;
  threadId: string;
  state: "pending" | "running" | "done" | "failed";
  runId?: string;
  failureReason?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  attemptCount?: number;
};

type SeedRunInput = {
  workspaceId: string;
  runId: string;
  threadId: string;
  triggerMessageId: string;
  command: string;
  startedAtMs?: number;
  endedAtMs?: number;
  exitCode?: number;
  failureReason?: string;
  logPath?: string;
  failureNotePosted?: boolean;
};

type LedgerEntry = { fingerprint: string; result: JsonValue };

function asObject(value: JsonValue, label: string): ChatsJsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function strictObject(
  value: JsonValue,
  label: string,
  allowed: readonly string[],
): ChatsJsonObject {
  const object = asObject(value, label);
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw new Error("invalid-parameters");
  }
  return object;
}

function requiredString(object: ChatsJsonObject, key: string, code = "invalid-input"): string {
  const value = object[key];
  if (typeof value !== "string") throw new Error(code);
  return value;
}

function optionalString(object: ChatsJsonObject, key: string): string | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("invalid-parameters");
  return value;
}

function optionalBoolean(object: ChatsJsonObject, key: string): boolean | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error("invalid-parameters");
  return value;
}

function optionalSafeInteger(
  object: ChatsJsonObject,
  key: string,
  minimum = 0,
): number | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error("invalid-parameters");
  }
  return value as number;
}

function requiredSafeInteger(
  object: ChatsJsonObject,
  key: string,
  code = "invalid-input",
): number {
  const value = object[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(code);
  return value as number;
}

function optionalInteger(
  object: ChatsJsonObject,
  key: string,
): number | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) throw new Error("invalid-parameters");
  return value as number;
}

function requiredInteger(object: ChatsJsonObject, key: string): number {
  const value = object[key];
  if (!Number.isSafeInteger(value)) throw new Error("invalid-input");
  return value as number;
}

function requiredBoolean(object: ChatsJsonObject, key: string): boolean {
  const value = object[key];
  if (typeof value !== "boolean") throw new Error("invalid-input");
  return value;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonResult(value: unknown): JsonValue {
  return jsonClone(value) as JsonValue;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function slug(name: string): string {
  return name
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function normalizeNonempty(value: string, code: string): string {
  const normalized = value.normalize("NFC").trim();
  if (normalized.length === 0) throw new Error(code);
  return normalized;
}

function normalizeTrimmed(value: string, code: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(code);
  return normalized;
}

const MAX_MESSAGE_BODY_BYTES = 64 * 1024;

// Mirrors the daemon `normalize_body` (dohc-engine-domain chats.rs): CRLF/CR -> LF,
// trimEnd only (leading whitespace preserved), non-empty, <= 64 KiB UTF-8. Used for
// both the stored body and the idempotency fingerprint so the loopback matches the
// daemon byte-for-byte instead of NFC-trimming both ends.
function normalizeMessageBody(value: string): string {
  const normalized = value.replace(/\r\n?/gu, "\n").trimEnd();
  if (
    normalized.length === 0 ||
    new TextEncoder().encode(normalized).length > MAX_MESSAGE_BODY_BYTES
  ) {
    throw new Error("invalid-message-body");
  }
  return normalized;
}

function normalizePath(path: string): string {
  const normalized = path.normalize("NFC").replaceAll("\\", "/").trim();
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..") ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error("invalid-path");
  }
  return normalized;
}

function isAbsolutePathLike(path: string): boolean {
  return (
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(path) ||
    path.startsWith("\\\\")
  );
}

function decodeTrackedPathEscapes(path: string): string {
  let decoded = path;
  for (;;) {
    const next = decoded
      .replace(/%25/giu, "%")
      .replace(/%2e/giu, ".")
      .replace(/%2f/giu, "/")
      .replace(/%5c/giu, "\\");
    if (next === decoded) return decoded;
    decoded = next;
  }
}

function stripWindowsAliasSuffix(segment: string): string {
  return segment.replace(/[. ]+$/u, "");
}

function isReserved83Alias(segment: string, stem: string): boolean {
  const match = /^([A-Za-z0-9]{1,8})~(\d+)$/u.exec(segment);
  if (!match) return false;
  const digits = match[2] ?? "";
  const baseLength = Math.min(stem.length, 7 - digits.length);
  return (
    baseLength >= 1 &&
    (match[1] ?? "").toUpperCase() === stem.slice(0, baseLength)
  );
}

function policySegments(path: string): string[] {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => stripWindowsAliasSuffix(segment).toLowerCase());
}

// Mirrors dohc-engine-files policy::classify_engine_file_path_normalized.
// Bookmark projections are plaintext, so only a canonical Tracked path may
// enter the projection queue.
function normalizeTrackedPath(path: string): string {
  if (path.includes("\0") || isAbsolutePathLike(path)) {
    throw new Error("invalid-path");
  }
  const decoded = decodeTrackedPathEscapes(path);
  if (isAbsolutePathLike(decoded)) throw new Error("invalid-path");
  const segments = decoded.replaceAll("\\", "/").split("/");
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." || /^[. ]+$/u.test(segment)) {
      throw new Error("invalid-path");
    }
  }
  const normalized = segments
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
  if (normalized.length === 0) throw new Error("invalid-path");

  const classifiedSegments = policySegments(normalized);
  const first = classifiedSegments[0] ?? "";
  const reserved =
    classifiedSegments.some(
      (segment) =>
        segment === ".dohc" || isReserved83Alias(segment, "DOHC"),
    ) ||
    first === "shared-with-me" ||
    isReserved83Alias(first, "SHARED");
  const ignored = classifiedSegments.some(
    (segment) =>
      segment === ".dohc" ||
      segment === ".git" ||
      segment === "node_modules" ||
      segment.startsWith(".dohc-write-"),
  );
  const basename = classifiedSegments.at(-1) ?? "";
  const secret =
    classifiedSegments.some((segment) => segment === ".env") ||
    basename.endsWith(".env") ||
    basename.startsWith(".env.");
  if (reserved || ignored || secret) throw new Error("invalid-path");
  return normalized;
}

function validateProjectionPath(path: string): string {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path[1] === ":" ||
    path.includes("..") ||
    path === ".dohc" ||
    path.startsWith(".dohc/")
  ) {
    throw new Error("invalid-bookmark-target");
  }
  return path;
}

function base32LowercaseNoPadding(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let output = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function projectionPath(workspaceId: string, threadId: string): string {
  const normalizeField = (value: string): string => {
    const normalized = value.normalize("NFC");
    if (
      normalized.length === 0 ||
      normalized === "." ||
      normalized === ".." ||
      /[/\\\u0000-\u001f\u007f]/u.test(normalized)
    ) {
      throw new Error("invalid-path");
    }
    return normalized;
  };
  const digest = createHash("sha256")
    .update(`v1\0${normalizeField(workspaceId)}\0${normalizeField(threadId)}\0thread`, "utf8")
    .digest();
  return `.dohc/chats/v1-${base32LowercaseNoPadding(digest)}.md`;
}

function reactionId(messageId: string, emoji: string, authorId: string): string {
  const digest = createHash("sha256")
    .update(messageId)
    .update("\0")
    .update(emoji)
    .update("\0")
    .update(authorId)
    .digest()
    .subarray(0, 16);
  return `reaction_${base32LowercaseNoPadding(digest)}`;
}

function attachmentId(
  messageId: string,
  objectId: string,
  headingAnchor?: string,
  headingOccurrence?: number,
): string {
  const hash = createHash("sha256");
  if (headingAnchor === undefined) {
    hash.update(`${messageId}file${objectId}`);
  } else {
    hash.update(`${messageId}\0file\0${objectId}\0${headingAnchor}\0${headingOccurrence ?? 0}`);
  }
  return hash.digest("hex");
}

function reactionCellKey(messageId: string, emoji: string, authorId: string): string {
  return `${messageId}\0${emoji}\0${authorId}`;
}

function bookmarkKey(ownerUserId: string, bookmarkId: string): string {
  return `${ownerUserId}\0${bookmarkId}`;
}

function bookmarkId(
  ownerUserId: string,
  targetKind: "message" | "thread",
  targetId: string,
): string {
  const digest = createHash("sha256")
    .update(ownerUserId)
    .update("\0")
    .update(targetKind)
    .update("\0")
    .update(targetId)
    .digest()
    .subarray(0, 16);
  return `bookmark_${base32LowercaseNoPadding(digest)}`;
}

function runLinkKey(messageId: string): string {
  return messageId;
}

function threadMessages(state: WorkspaceState, threadId: string): ChatMessage[] {
  return (state.threadMessages.get(threadId) ?? [])
    .map((messageId) => state.messages.get(messageId))
    .filter((message): message is ChatMessage => message !== undefined)
    .sort((left, right) => left.createdAtMs - right.createdAtMs || compareText(left.id, right.id));
}

function activeMessageReactions(state: WorkspaceState, messageId: string): ChatReaction[] {
  return [...state.reactions.values()]
    .filter((reaction) => reaction.messageId === messageId && reaction.state === "added")
    .sort((left, right) => left.atMs - right.atMs || compareText(left.reactionId, right.reactionId))
    .map(jsonClone);
}

function personalFeedMessages(
  state: WorkspaceState,
  workspace: string,
  ownerUserId: string,
): ChatMessage[] {
  const follows = state.follows.get(ownerUserId) ?? new Set<string>();
  return [...state.messages.values()]
    .filter((message) => {
      const thread = state.threads.get(message.threadId);
      const channel = thread?.channelId
        ? state.channels.get(thread.channelId)
        : undefined;
      const openingMessageId = thread
        ? threadMessages(state, thread.id)[0]?.id
        : undefined;
      return message.workspaceId === workspace && !!thread && (
        follows.has(`thread\0${thread.id}`) ||
        (
          message.id === openingMessageId &&
          channel?.wireId !== null &&
          channel?.wireId !== undefined &&
          follows.has(`channel\0${channel.wireId}`)
        ) ||
        (
          message.author.kind === "human" &&
          message.authorUserId !== undefined &&
          follows.has(`person\0${message.authorUserId}`)
        ) ||
        (
          message.author.kind === "agent" &&
          message.authorUserId !== undefined &&
          follows.has(`agent\0${message.authorUserId}`)
        )
      );
    })
    .sort(
      (left, right) =>
        right.createdAtMs - left.createdAtMs ||
        compareText(right.id, left.id),
    );
}

function codeRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fenceRe = /^[ \t]*(`{3,}|~{3,})/u;
  let offset = 0;
  let openFence: { char: string; len: number; start: number } | undefined;
  for (const line of body.split("\n")) {
    const marker = fenceRe.exec(line)?.[1];
    if (!openFence && marker) {
      openFence = { char: marker[0] ?? "", len: marker.length, start: offset };
    } else if (
      openFence &&
      marker?.[0] === openFence.char &&
      marker.length >= openFence.len &&
      line.trim() === marker
    ) {
      ranges.push([openFence.start, offset + line.length]);
      openFence = undefined;
    }
    offset += line.length + 1;
  }
  if (openFence) ranges.push([openFence.start, body.length]);
  const inFence = (position: number): boolean =>
    ranges.some(([start, end]) => position >= start && position < end);
  const runRe = /`+/gu;
  let open: { len: number; start: number } | undefined;
  for (let match = runRe.exec(body); match !== null; match = runRe.exec(body)) {
    if (inFence(match.index)) continue;
    if (!open) open = { len: match[0].length, start: match.index };
    else if (open.len === match[0].length) {
      ranges.push([open.start, match.index + match[0].length]);
      open = undefined;
    }
  }
  return ranges;
}

function mentionHandles(body: string): string[] {
  const ranges = codeRanges(body);
  const regex = /(^|[\s(\[{])@([a-z0-9][a-z0-9._-]*)/giu;
  const handles: string[] = [];
  const seen = new Set<string>();
  for (let match = regex.exec(body); match !== null; match = regex.exec(body)) {
    const start = match.index + (match[1]?.length ?? 0);
    if (ranges.some(([from, to]) => start >= from && start < to)) continue;
    const handle = (match[2] ?? "").replace(/[._-]+$/u, "").normalize("NFC").toLowerCase();
    if (handle.length > 0 && !seen.has(handle)) {
      seen.add(handle);
      handles.push(handle);
    }
  }
  return handles;
}

function validateEmoji(value: string): string {
  const emoji = value.normalize("NFC").trim();
  if (emoji.length === 0 || emoji.length > 32) throw new Error("invalid-message-body");
  const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(emoji)];
  if (segments.length !== 1 || !/\p{Extended_Pictographic}/u.test(emoji)) {
    throw new Error("invalid-message-body");
  }
  return emoji;
}

function pageLimit(params: ChatsJsonObject): number {
  const value = optionalSafeInteger(params, "pageLimit", 1) ?? DEFAULT_PAGE_LIMIT;
  if (value > MAX_PAGE_LIMIT) throw new Error("invalid-parameters");
  return value;
}

function encodeCursor(binding: string, index: number): string {
  return Buffer.from(JSON.stringify({ version: 1, binding, index }), "utf8").toString("base64url");
}

function encodeFeedCursor(message: ChatMessage): string {
  return Buffer.from(
    JSON.stringify([message.createdAtMs, message.id]),
    "utf8",
  ).toString("base64url");
}

function decodeFeedCursor(cursor: string): {
  createdAtMs: number;
  messageId: string;
} {
  try {
    if (
      cursor.length === 0 ||
      cursor.length > 512 ||
      !/^[A-Za-z0-9_-]+$/u.test(cursor)
    ) {
      throw new Error();
    }
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (
      Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url") !==
      cursor
    ) {
      throw new Error();
    }
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      !Number.isSafeInteger(decoded[0]) ||
      typeof decoded[1] !== "string" ||
      decoded[1].length === 0 ||
      decoded[1].length > 256
    ) {
      throw new Error();
    }
    return { createdAtMs: decoded[0] as number, messageId: decoded[1] };
  } catch {
    throw new Error("invalid-follow-target");
  }
}

function decodeCursor(params: ChatsJsonObject, binding: string): number {
  const raw = optionalString(params, "cursor");
  if (raw === undefined) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      version?: unknown;
      binding?: unknown;
      index?: unknown;
    };
    if (
      parsed.version !== 1 ||
      parsed.binding !== binding ||
      !Number.isSafeInteger(parsed.index) ||
      (parsed.index as number) < 0
    ) {
      throw new Error();
    }
    return parsed.index as number;
  } catch {
    throw new Error("invalid-cursor");
  }
}

function page<T>(
  rows: readonly T[],
  params: ChatsJsonObject,
  binding: string,
): { values: T[]; nextCursor: string | null } {
  const start = decodeCursor(params, binding);
  const limit = pageLimit(params);
  const values = rows.slice(start, start + limit).map(jsonClone);
  const next = start + values.length;
  return {
    values,
    nextCursor: next < rows.length ? encodeCursor(binding, next) : null,
  };
}

function allowedKeys(method: string): readonly string[] {
  switch (method) {
    case CHATS_METHOD.channelCreate: return ["channelId", "name", "kind", "nowMs"];
    case CHATS_METHOD.channelEnsureAgent:
    case CHATS_METHOD.channelEnsureGeneral:
      return ["channelId", "nowMs"];
    case CHATS_METHOD.channelFindBySlug: return ["slug"];
    case CHATS_METHOD.channelsList:
    case CHATS_METHOD.threadsList:
      return [];
    case CHATS_METHOD.channelGetWireId: return ["channelId"];
    case CHATS_METHOD.threadStart:
      return [
        "channelId", "threadId", "messageId", "title", "authorKind", "authorDisplayName",
        "authorUserId", "origin", "body", "needsDecision", "attachments", "nowMs",
      ];
    case CHATS_METHOD.threadCreate: return ["threadId", "title", "linkedFile", "nowMs"];
    case CHATS_METHOD.threadsListForFile: return ["objectId", "pageLimit", "cursor"];
    case CHATS_METHOD.threadsListForChannel: return ["channelId", "pageLimit", "cursor"];
    case CHATS_METHOD.threadFindChannelId:
    case CHATS_METHOD.dispatchIsThreadPaused:
    case CHATS_METHOD.dispatchGetThreadPauseState:
      return ["threadId"];
    case CHATS_METHOD.threadGetProjection: return ["threadId", "linkedFileAccess"];
    case CHATS_METHOD.messageSend:
      return [
        "threadId", "messageId", "authorKind", "authorDisplayName", "authorUserId",
        "parentMessageId", "origin", "body", "needsDecision", "attachments", "nowMs",
      ];
    case CHATS_METHOD.messagesList:
      return ["threadId", "limit", "afterMessageOrder"];
    case CHATS_METHOD.readStateGet:
      return ["threadId"];
    case CHATS_METHOD.readStateMarkThreadRead:
      return ["threadId", "upToSequence", "expectedRevision", "nowMs"];
    case CHATS_METHOD.decisionResolve:
      return ["threadId", "messageId", "resolvedByMessageId", "nowMs"];
    case CHATS_METHOD.reactionSet:
      return ["threadId", "messageId", "emoji", "author", "state", "nowMs"];
    case CHATS_METHOD.decisionsListForThread:
    case CHATS_METHOD.reactionsList:
    case CHATS_METHOD.attachmentsListForThread:
      return ["threadId", "pageLimit", "cursor"];
    case CHATS_METHOD.attachmentsListFileMentions:
      return ["objectId", "pathHint", "pageLimit", "cursor"];
    case CHATS_METHOD.mentionsListForHandle:
      return ["handle", "unreadByAgentOnly", "pageLimit", "cursor"];
    case CHATS_METHOD.agentReadListUnreadThreads:
    case CHATS_METHOD.dispatchListPending:
    case CHATS_METHOD.dispatchOpenRuns:
    case CHATS_METHOD.dispatchListAppQuitRecoveries:
      return ["pageLimit", "cursor"];
    case CHATS_METHOD.agentReadMarkThreadRead:
      return ["threadId", "upTo", "expectedRevision"];
    case CHATS_METHOD.followsSet:
      return [
        "ownerUserId", "replicationOwnerUserId", "targetKind", "targetId", "state", "nowMs",
      ];
    case CHATS_METHOD.followsList:
      return ["ownerUserId", "state"];
    case CHATS_METHOD.followsEnsureDefaults: return ["ownerUserId"];
    case CHATS_METHOD.feedMarkSeen:
      return ["ownerUserId", "replicationOwnerUserId", "headCursor", "nowMs"];
    case CHATS_METHOD.feedListPersonal: return ["ownerUserId", "limit", "cursor"];
    case CHATS_METHOD.bookmarkSave:
      return ["ownerUserId", "targetKind", "targetId", "mode", "destinationPath", "nowMs"];
    case CHATS_METHOD.bookmarksList:
      return ["ownerUserId", "state"];
    case CHATS_METHOD.bookmarkFind:
    case CHATS_METHOD.bookmarkArchive:
    case CHATS_METHOD.bookmarkMarkPending:
      return ["ownerUserId", "bookmarkId"];
    case CHATS_METHOD.bookmarkListPending:
      return ["ownerUserId", "limit", "pageLimit", "cursor"];
    case CHATS_METHOD.bookmarkMarkReady:
      return [
        "ownerUserId", "bookmarkId", "generation", "projectedAtMs",
        "projectionObjectId", "projectionPath",
      ];
    case CHATS_METHOD.bookmarkMarkFailed:
      return ["ownerUserId", "bookmarkId", "generation", "failureReason"];
    case CHATS_METHOD.bookmarkMarkStale:
      return ["ownerUserId", "bookmarkId", "generation", "failureReason"];
    case CHATS_METHOD.dispatchRecordEligibleTriggers: return ["verifiedUserId"];
    case CHATS_METHOD.dispatchEnqueue:
      return ["triggerMessageId", "threadId", "nowMs"];
    case CHATS_METHOD.dispatchClaimNextPending: return ["runId", "command", "logPath", "nowMs"];
    case CHATS_METHOD.dispatchListRunMessages: return ["runId", "pageLimit", "cursor"];
    case CHATS_METHOD.dispatchRunIdForMessage: return ["messageId"];
    case CHATS_METHOD.dispatchRunRecordsForThread:
      return ["threadId", "limit", "pageLimit", "cursor"];
    case CHATS_METHOD.dispatchGetRunRecord:
    case CHATS_METHOD.dispatchMarkFailureNotePosted:
      return ["runId"];
    case CHATS_METHOD.dispatchRecentCount: return ["threadId", "sinceMs"];
    case CHATS_METHOD.dispatchFailPendingForThread: return ["threadId", "reason"];
    case CHATS_METHOD.dispatchRecordRunMessage: return ["messageId", "runId"];
    case CHATS_METHOD.dispatchSetThreadPaused: return ["threadId", "paused", "reason"];
    case CHATS_METHOD.dispatchRequeueFailedTrigger: return ["triggerMessageId", "runId"];
    case CHATS_METHOD.dispatchComplete: return ["runId", "exitCode", "nowMs"];
    case CHATS_METHOD.dispatchFail: return ["runId", "reason", "exitCode", "nowMs"];
    default: throw new Error(`Unsupported loopback method: ${method}`);
  }
}

export class ChatsLoopbackEngine implements EngineTransport {
  readonly requests: Request[] = [];
  readonly responses: Response[] = [];

  private readonly workspaces = new Map<string, WorkspaceState>();
  private readonly ledger = new Map<string, LedgerEntry>();
  private clock = 1;

  onEvent(_handler: (event: Event) => void): () => void {
    return () => undefined;
  }

  seedChannel(input: SeedChannelInput): ChatChannel {
    const state = this.workspace(input.workspace);
    const name = normalizeNonempty(input.name, "invalid-channel-name");
    const wantedSlug = slug(name);
    if ([...state.channels.values()].some((channel) => channel.slug === wantedSlug)) {
      throw new Error("channel-exists");
    }
    if (state.channels.has(input.channelId)) throw new Error("target-exists");
    const atMs = this.tick(input.createdAtMs);
    const channel: ChatChannel & { wireId: string | null } = {
      workspaceId: input.workspace,
      channelId: input.channelId,
      name,
      slug: wantedSlug,
      kind: input.kind ?? "channel",
      createdAtMs: atMs,
      updatedAtMs: atMs,
      wireId: input.wireId === undefined ? input.channelId : input.wireId,
    };
    state.channels.set(channel.channelId, channel);
    return jsonClone(channel);
  }

  seedFollow(
    workspace: string,
    ownerUserId: string,
    targetKind: "person" | "agent" | "channel" | "thread",
    targetId: string,
  ): void {
    const state = this.workspace(workspace);
    const follows = state.follows.get(ownerUserId) ?? new Set<string>();
    follows.add(`${targetKind}\0${targetId}`);
    state.follows.set(ownerUserId, follows);
  }

  seedThreadRead(workspace: string, threadId: string, lastReadSequence: number): void {
    if (!Number.isSafeInteger(lastReadSequence) || lastReadSequence < 0) {
      throw new Error("invalid-read-cursor");
    }
    this.workspace(workspace).humanReads.set(threadId, lastReadSequence);
  }

  seedBookmark(input: SeedBookmarkInput): ChatBookmark {
    const state = this.workspace(input.workspaceId);
    const key = bookmarkKey(input.ownerUserId, input.bookmarkId);
    if (state.bookmarks.has(key)) throw new Error("target-exists");
    if (
      [...state.bookmarks.values()].some(
        (bookmark) =>
          bookmark.ownerUserId === input.ownerUserId &&
          bookmark.destinationPath === input.destinationPath,
      )
    ) {
      throw new Error("target-exists");
    }
    const createdAtMs = this.tick(input.createdAtMs);
    const bookmark: ChatBookmark = {
      ...jsonClone(input),
      createdAtMs,
      updatedAtMs: input.updatedAtMs ?? createdAtMs,
      generation: input.generation ?? 1,
      projectedGeneration: input.projectedGeneration ?? 0,
      projectionState: input.projectionState ?? "pending",
    };
    state.bookmarks.set(key, bookmark);
    return jsonClone(bookmark);
  }

  seedDispatch(input: SeedDispatchInput): ChatDispatch {
    const state = this.workspace(input.workspaceId);
    if (state.dispatches.has(input.triggerMessageId)) return jsonClone(state.dispatches.get(input.triggerMessageId)!);
    const createdAtMs = this.tick(input.createdAtMs);
    const dispatch: ChatDispatch = {
      ...jsonClone(input),
      attemptCount: input.attemptCount ?? 0,
      createdAtMs,
      updatedAtMs: input.updatedAtMs ?? createdAtMs,
    };
    state.dispatches.set(dispatch.triggerMessageId, dispatch);
    return jsonClone(dispatch);
  }

  seedRun(input: SeedRunInput): ChatRun {
    const state = this.workspace(input.workspaceId);
    if (state.runs.has(input.runId)) throw new Error("target-exists");
    const run: ChatRun = {
      ...jsonClone(input),
      startedAtMs: this.tick(input.startedAtMs),
      failureNotePosted: input.failureNotePosted ?? false,
    };
    state.runs.set(run.runId, run);
    return jsonClone(run);
  }

  async sendRequest(request: Request): Promise<Response> {
    this.requests.push(jsonClone(request));
    const result = this.handleRequest(request);
    const response = { id: request.id, result };
    this.responses.push(jsonClone(response));
    return response;
  }

  private handleRequest(request: Request): JsonValue {
    if (typeof request.workspace !== "string") throw new Error("workspace-unavailable");
    const workspace = request.workspace;
    const state = this.workspace(workspace);
    const params = strictObject(request.params, `${request.method} params`, allowedKeys(request.method));
    switch (request.method) {
      case CHATS_METHOD.channelCreate:
        return this.channelCreate(state, workspace, params);
      case CHATS_METHOD.channelEnsureGeneral:
        return this.channelEnsure(state, workspace, params, "general", "channel");
      case CHATS_METHOD.channelEnsureAgent:
        return this.channelEnsure(state, workspace, params, "My agent", "agent");
      case CHATS_METHOD.channelsList:
        return this.channelsList(state, workspace);
      case CHATS_METHOD.channelFindBySlug:
        return this.channelFindBySlug(state, params);
      case CHATS_METHOD.channelGetWireId:
        return this.channelGetWireId(state, params);
      case CHATS_METHOD.threadStart:
        return this.replay(request, workspace, params, false, () =>
          this.threadStart(state, workspace, params));
      case CHATS_METHOD.threadCreate:
        return this.replay(request, workspace, params, true, () =>
          this.threadCreate(state, workspace, params));
      case CHATS_METHOD.threadsList:
        return this.threadsList(state, workspace);
      case CHATS_METHOD.threadsListForFile:
        return this.threadsListForFile(state, workspace, params);
      case CHATS_METHOD.threadsListForChannel:
        return this.threadsListForChannel(state, workspace, params);
      case CHATS_METHOD.threadFindChannelId:
        return this.threadFindChannelId(state, params);
      case CHATS_METHOD.threadGetProjection:
        return this.threadProjection(state, workspace, params);
      case CHATS_METHOD.messageSend:
        return this.replay(request, workspace, params, false, () =>
          this.messageSend(state, workspace, params));
      case CHATS_METHOD.messagesList:
        return this.messagesList(state, params);
      case CHATS_METHOD.readStateGet:
        return this.readStateGet(state, workspace, params);
      case CHATS_METHOD.readStateMarkThreadRead:
        return this.readStateMark(state, workspace, params);
      case CHATS_METHOD.decisionResolve:
        return this.replay(request, workspace, params, true, () =>
          this.decisionResolve(state, params));
      case CHATS_METHOD.decisionsListForThread:
        return this.decisionsList(state, workspace, params);
      case CHATS_METHOD.reactionSet:
        return this.replay(request, workspace, params, true, () =>
          this.reactionSet(state, params));
      case CHATS_METHOD.reactionsList:
        return this.reactionsList(state, workspace, params);
      case CHATS_METHOD.attachmentsListForThread:
        return this.attachmentsList(state, workspace, params);
      case CHATS_METHOD.attachmentsListFileMentions:
        return this.fileMentions(state, workspace, params);
      case CHATS_METHOD.mentionsListForHandle:
        return this.mentionsList(state, workspace, params);
      case CHATS_METHOD.agentReadListUnreadThreads:
        return this.agentUnreadThreads(state, workspace, params);
      case CHATS_METHOD.agentReadMarkThreadRead:
        return this.agentMarkRead(state, workspace, params);
      case CHATS_METHOD.followsSet:
        return this.followSet(state, workspace, params);
      case CHATS_METHOD.followsList:
        return this.followsList(state, workspace, params);
      case CHATS_METHOD.followsEnsureDefaults:
        return this.ensureDefaultFollows(state, params);
      case CHATS_METHOD.feedMarkSeen:
        return this.feedMarkSeen(state, workspace, params);
      case CHATS_METHOD.feedListPersonal:
        return this.feedList(state, workspace, params);
      case CHATS_METHOD.bookmarkSave:
        return this.bookmarkSave(state, workspace, params);
      case CHATS_METHOD.bookmarksList:
        return this.bookmarksList(state, params);
      case CHATS_METHOD.bookmarkFind:
        return this.bookmarkFind(state, params);
      case CHATS_METHOD.bookmarkListPending:
        return this.bookmarkListPending(state, workspace, params);
      case CHATS_METHOD.bookmarkMarkReady:
        return this.bookmarkMarkReady(state, params);
      case CHATS_METHOD.bookmarkArchive:
        return this.bookmarkArchive(state, params);
      case CHATS_METHOD.bookmarkMarkPending:
        return this.replay(request, workspace, params, true, () =>
          this.bookmarkMarkPending(state, params));
      case CHATS_METHOD.bookmarkMarkFailed:
        return this.bookmarkTransition(state, params, "failed");
      case CHATS_METHOD.bookmarkMarkStale:
        return this.bookmarkTransition(state, params, "stale");
      case CHATS_METHOD.dispatchEnqueue:
        return this.dispatchEnqueue(state, workspace, params);
      case CHATS_METHOD.dispatchRecordEligibleTriggers:
        return this.recordEligibleTriggers(state, workspace, params);
      case CHATS_METHOD.dispatchClaimNextPending:
        return this.claimNextPending(state, workspace, params);
      case CHATS_METHOD.dispatchListPending:
        return this.dispatchListPending(state, workspace, params);
      case CHATS_METHOD.dispatchOpenRuns:
        return this.dispatchOpenRuns(state, workspace, params);
      case CHATS_METHOD.dispatchListRunMessages:
        return this.listRunMessages(state, workspace, params);
      case CHATS_METHOD.dispatchRunIdForMessage:
        return this.runIdForMessage(state, params);
      case CHATS_METHOD.dispatchRunRecordsForThread:
        return this.runRecordsForThread(state, workspace, params);
      case CHATS_METHOD.dispatchGetRunRecord:
        return this.getRunRecord(state, params);
      case CHATS_METHOD.dispatchIsThreadPaused:
        return jsonResult(state.pauses.get(requiredString(params, "threadId"))?.paused ?? false);
      case CHATS_METHOD.dispatchGetThreadPauseState:
        return jsonResult(state.pauses.get(requiredString(params, "threadId")) ?? null);
      case CHATS_METHOD.dispatchRecentCount:
        return this.recentCount(state, params);
      case CHATS_METHOD.dispatchFailPendingForThread:
        return this.failPending(state, params);
      case CHATS_METHOD.dispatchRecordRunMessage:
        return this.recordRunMessage(state, workspace, params);
      case CHATS_METHOD.dispatchSetThreadPaused:
        return this.setThreadPaused(state, workspace, params);
      case CHATS_METHOD.dispatchMarkFailureNotePosted:
        return this.markFailureNotePosted(state, workspace, params);
      case CHATS_METHOD.dispatchRequeueFailedTrigger:
        return this.requeueFailed(state, workspace, params);
      case CHATS_METHOD.dispatchListAppQuitRecoveries:
        return this.appQuitRecoveries(state, workspace, params);
      case CHATS_METHOD.dispatchComplete:
        return this.dispatchComplete(state, workspace, params);
      case CHATS_METHOD.dispatchFail:
        return this.dispatchFail(state, workspace, params);
      default:
        throw new Error(`Unsupported loopback method: ${request.method}`);
    }
  }

  private replay(
    request: Request,
    workspace: string,
    params: ChatsJsonObject,
    required: boolean,
    operation: () => JsonValue,
  ): JsonValue {
    const key = request.idempotencyKey;
    if (required && (typeof key !== "string" || key.length === 0)) {
      throw new Error("idempotency-key-required");
    }
    if (typeof key !== "string" || key.length === 0) return operation();
    const ledgerKey = `${workspace}\0${request.method}\0${key}`;
    const fingerprint = this.writeFingerprint(request.method, workspace, params);
    const prior = this.ledger.get(ledgerKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error("idempotency-key-reuse-mismatch");
      return jsonClone(prior.result);
    }
    const result = operation();
    this.ledger.set(ledgerKey, { fingerprint, result: jsonClone(result) });
    return result;
  }

  private writeFingerprint(
    method: string,
    workspace: string,
    params: ChatsJsonObject,
  ): string {
    switch (method) {
      case CHATS_METHOD.threadStart:
        optionalSafeInteger(params, "nowMs");
        return JSON.stringify([
          normalizeTrimmed(requiredString(params, "threadId"), "invalid-input"),
          requiredString(params, "messageId", "invalid-message-body"),
          requiredString(params, "channelId"),
          optionalString(params, "title")?.trim() ?? "",
          normalizeMessageBody(requiredString(params, "body", "invalid-message-body")),
          requiredString(params, "authorKind", "invalid-sender"),
          normalizeTrimmed(
            requiredString(params, "authorDisplayName", "invalid-sender"),
            "invalid-sender",
          ),
          this.optionalNormalizedString(params, "authorUserId", "invalid-sender"),
          this.normalizedOrigin(params),
          optionalBoolean(params, "needsDecision") ?? false,
          this.attachmentFingerprint(params),
        ]);
      case CHATS_METHOD.threadCreate: {
        optionalSafeInteger(params, "nowMs");
        const linked = strictObject(params.linkedFile ?? null, "linkedFile", [
          "objectId", "pathHint",
        ]);
        const pathHint = optionalString(linked, "pathHint");
        return JSON.stringify([
          workspace,
          normalizeTrimmed(requiredString(params, "threadId"), "invalid-input"),
          normalizeTrimmed(
            requiredString(params, "title", "invalid-thread-title"),
            "invalid-thread-title",
          ),
          normalizeTrimmed(
            requiredString(linked, "objectId", "invalid-path"),
            "invalid-path",
          ),
          pathHint === undefined ? "" : normalizePath(pathHint),
        ]);
      }
      case CHATS_METHOD.messageSend:
        optionalSafeInteger(params, "nowMs");
        return JSON.stringify([
          requiredString(params, "threadId"),
          requiredString(params, "messageId", "invalid-message-body"),
          normalizeMessageBody(requiredString(params, "body", "invalid-message-body")),
          requiredString(params, "authorKind", "invalid-sender"),
          normalizeTrimmed(
            requiredString(params, "authorDisplayName", "invalid-sender"),
            "invalid-sender",
          ),
          this.optionalNormalizedString(params, "authorUserId", "invalid-sender"),
          optionalString(params, "parentMessageId") ?? "",
          this.normalizedOrigin(params),
          optionalBoolean(params, "needsDecision") ?? false,
          this.attachmentFingerprint(params),
        ]);
      case CHATS_METHOD.decisionResolve:
        optionalSafeInteger(params, "nowMs");
        return JSON.stringify([
          normalizeTrimmed(requiredString(params, "threadId"), "invalid-input"),
          requiredString(params, "messageId"),
          requiredString(params, "resolvedByMessageId", "invalid-message-body"),
        ]);
      case CHATS_METHOD.reactionSet: {
        optionalSafeInteger(params, "nowMs");
        const author = strictObject(params.author ?? null, "author", [
          "authorId", "kind", "displayName",
        ]);
        return JSON.stringify([
          normalizeTrimmed(requiredString(params, "threadId"), "invalid-input"),
          requiredString(params, "messageId"),
          validateEmoji(requiredString(params, "emoji", "invalid-message-body")),
          normalizeTrimmed(
            requiredString(author, "authorId", "invalid-sender"),
            "invalid-sender",
          ),
          requiredString(author, "kind", "invalid-sender"),
          normalizeTrimmed(
            requiredString(author, "displayName", "invalid-sender"),
            "invalid-sender",
          ),
          requiredString(params, "state", "invalid-parameters"),
        ]);
      }
      case CHATS_METHOD.bookmarkMarkPending:
        return JSON.stringify([
          workspace,
          normalizeTrimmed(
            requiredString(params, "ownerUserId", "invalid-follow-target"),
            "invalid-follow-target",
          ),
          normalizeTrimmed(
            requiredString(params, "bookmarkId", "invalid-bookmark-target"),
            "invalid-bookmark-target",
          ),
        ]);
      default:
        throw new Error(`Unsupported replay method: ${method}`);
    }
  }

  private optionalNormalizedString(
    params: ChatsJsonObject,
    key: string,
    code: string,
  ): string {
    const value = optionalString(params, key);
    return value === undefined ? "" : normalizeTrimmed(value, code);
  }

  private normalizedOrigin(params: ChatsJsonObject): string {
    const origin = optionalString(params, "origin");
    if (origin !== undefined && origin !== "cli") throw new Error("invalid-message-body");
    return origin ?? "";
  }

  private attachmentFingerprint(
    params: ChatsJsonObject,
  ): Array<[string, string, string, string, number | null]> {
    const values = params.attachments;
    if (values === undefined) return [];
    if (!Array.isArray(values)) throw new Error("invalid-parameters");
    const seen = new Set<string>();
    const normalized: Array<[string, string, string, string, number | null]> = [];
    for (const [index, value] of values.entries()) {
      const input = strictObject(value, `attachments[${index}]`, [
        "objectId", "pathHint", "headingText", "headingAnchor", "headingOccurrence",
      ]);
      const objectId = normalizeTrimmed(
        requiredString(input, "objectId", "invalid-path"),
        "invalid-path",
      );
      const pathHintInput = optionalString(input, "pathHint");
      const pathHint = pathHintInput === undefined ? "" : normalizePath(pathHintInput);
      const headingTextInput = optionalString(input, "headingText");
      const headingAnchorInput = optionalString(input, "headingAnchor");
      const headingOccurrence = optionalSafeInteger(input, "headingOccurrence");
      const headingCount = [
        headingTextInput, headingAnchorInput, headingOccurrence,
      ].filter((entry) => entry !== undefined).length;
      if (headingCount !== 0 && headingCount !== 3) throw new Error("invalid-path");
      const headingText = headingTextInput === undefined
        ? ""
        : normalizeNonempty(headingTextInput, "invalid-path");
      const headingAnchor = headingAnchorInput === undefined
        ? ""
        : normalizeNonempty(headingAnchorInput, "invalid-path");
      const dedup = `${objectId}\0${headingAnchor}\0${headingOccurrence ?? ""}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      normalized.push([
        objectId,
        pathHint,
        headingText,
        headingAnchor,
        headingOccurrence ?? null,
      ]);
    }
    return normalized;
  }

  private channelJson(
    channel: ChatChannel & { wireId?: string | null },
  ): ChatChannel {
    return {
      workspaceId: channel.workspaceId,
      channelId: channel.channelId,
      name: channel.name,
      slug: channel.slug,
      kind: channel.kind,
      createdAtMs: channel.createdAtMs,
      updatedAtMs: channel.updatedAtMs,
    };
  }

  private channelCreate(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const channelId = requiredString(params, "channelId");
    const name = normalizeNonempty(
      requiredString(params, "name", "invalid-channel-name"),
      "invalid-channel-name",
    );
    const kind = requiredString(params, "kind");
    if (kind !== "channel" && kind !== "dm" && kind !== "agent") {
      throw new Error("invalid-channel-kind");
    }
    if (state.channels.has(channelId)) throw new Error("target-exists");
    const channelSlug = slug(name);
    if (
      [...state.channels.values()].some(
        (channel) => channel.slug === channelSlug,
      )
    ) {
      throw new Error("channel-exists");
    }
    const atMs = this.tick(optionalSafeInteger(params, "nowMs"));
    const channel: ChatChannel & { wireId: string | null } = {
      workspaceId: workspace,
      channelId,
      name,
      slug: channelSlug,
      kind,
      createdAtMs: atMs,
      updatedAtMs: atMs,
      wireId: channelId,
    };
    state.channels.set(channelId, channel);
    return jsonResult(this.channelJson(channel));
  }

  private channelEnsure(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
    name: string,
    kind: "channel" | "agent",
  ): JsonValue {
    const wantedSlug = slug(name);
    const existing = [...state.channels.values()].find(
      (channel) => channel.slug === wantedSlug,
    );
    if (existing) return jsonResult(this.channelJson(existing));
    return this.channelCreate(state, workspace, {
      channelId: requiredString(params, "channelId"),
      name,
      kind,
      ...(params.nowMs !== undefined ? { nowMs: params.nowMs } : {}),
    });
  }

  private channelsList(state: WorkspaceState, workspace: string): JsonValue {
    const channels = [...state.channels.values()]
      .filter((channel) => channel.workspaceId === workspace)
      .sort(
        (left, right) =>
          left.createdAtMs - right.createdAtMs ||
          compareText(left.channelId, right.channelId),
      )
      .map((channel) => {
        const threads = [...state.threads.values()].filter(
          (thread) => thread.channelId === channel.channelId,
        );
        return {
          ...this.channelJson(channel),
          threadCount: threads.length,
          unreadCount: threads.reduce((count, thread) => {
            const total = threadMessages(state, thread.id).length;
            return count + Math.max(0, total - (state.humanReads.get(thread.id) ?? 0));
          }, 0),
        };
      });
    return jsonResult({ channels, truncated: false });
  }

  private channelFindBySlug(
    state: WorkspaceState,
    params: ChatsJsonObject,
  ): JsonValue {
    const wanted = requiredString(params, "slug");
    const channel = [...state.channels.values()].find(
      (candidate) => candidate.slug === wanted,
    );
    return jsonResult(channel ? this.channelJson(channel) : null);
  }

  private channelGetWireId(state: WorkspaceState, params: ChatsJsonObject): JsonValue {
    const channel = state.channels.get(requiredString(params, "channelId"));
    if (!channel) throw new Error("channel-not-found");
    return jsonResult({ wireId: channel.wireId });
  }

  private threadStart(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const channelId = requiredString(params, "channelId");
    if (!state.channels.has(channelId)) throw new Error("channel-not-found");
    const threadId = requiredString(params, "threadId");
    if (state.threads.has(threadId)) throw new Error("target-exists");
    const body = normalizeMessageBody(requiredString(params, "body", "invalid-message-body"));
    const atMs = this.tick(optionalSafeInteger(params, "nowMs"));
    const title = optionalString(params, "title")?.trim() || body.split("\n")[0]?.slice(0, 80) || "New chat";
    const thread: ChatThread = {
      id: threadId,
      workspaceId: workspace,
      title,
      createdAtMs: atMs,
      updatedAtMs: atMs,
      channelId,
    };
    state.threads.set(threadId, thread);
    const message = this.insertMessage(state, workspace, params, threadId, atMs);
    return jsonResult({ thread, message });
  }

  private threadCreate(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const threadId = requiredString(params, "threadId");
    if (state.threads.has(threadId)) throw new Error("target-exists");
    const linked = strictObject(params.linkedFile ?? null, "linkedFile", ["objectId", "pathHint"]);
    const objectId = normalizeNonempty(requiredString(linked, "objectId", "invalid-path"), "invalid-path");
    const pathHint = optionalString(linked, "pathHint");
    const atMs = this.tick(optionalSafeInteger(params, "nowMs"));
    const thread: ChatThread = {
      id: threadId,
      workspaceId: workspace,
      title: normalizeNonempty(requiredString(params, "title", "invalid-thread-title"), "invalid-thread-title"),
      createdAtMs: atMs,
      updatedAtMs: atMs,
      linkedFile: {
        objectId,
        linkedAtMs: atMs,
        ...(pathHint === undefined ? {} : { pathHint: normalizePath(pathHint) }),
      },
    };
    state.threads.set(threadId, thread);
    return jsonResult(thread);
  }

  private threadsList(state: WorkspaceState, workspace: string): JsonValue {
    const threads = [...state.threads.values()]
      .filter((thread) => thread.workspaceId === workspace)
      .sort(
        (left, right) =>
          left.createdAtMs - right.createdAtMs ||
          compareText(left.id, right.id),
      )
      .map((thread) => ({
        workspaceId: thread.workspaceId,
        threadId: thread.id,
        title: thread.title,
        createdAtMs: thread.createdAtMs,
        updatedAtMs: thread.updatedAtMs,
        channelId: thread.channelId ?? null,
        linkedObjectId: thread.linkedFile?.objectId ?? null,
      }));
    return jsonResult({ threads, truncated: false });
  }

  private messageSend(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const threadId = requiredString(params, "threadId");
    const thread = this.requireThread(state, threadId);
    const message = this.insertMessage(
      state,
      workspace,
      params,
      threadId,
      this.tick(optionalSafeInteger(params, "nowMs")),
    );
    thread.updatedAtMs = Math.max(thread.updatedAtMs, message.createdAtMs);
    return jsonResult(message);
  }

  private messagesList(
    state: WorkspaceState,
    params: ChatsJsonObject,
  ): JsonValue {
    const threadId = requiredString(params, "threadId");
    this.requireThread(state, threadId);
    const messages = threadMessages(state, threadId);
    const after = optionalSafeInteger(params, "afterMessageOrder") ?? 0;
    const limit = Math.min(optionalSafeInteger(params, "limit", 1) ?? 100, 500);
    const rows = messages.slice(after, after + limit);
    const next =
      after + rows.length < messages.length ? after + rows.length : null;
    return jsonResult({ messages: rows, nextAfterMessageOrder: next });
  }

  private readStateGet(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const threadId = requiredString(params, "threadId");
    this.requireThread(state, threadId);
    return jsonResult(
      state.humanReadStates.get(threadId) ?? {
        workspaceId: workspace,
        threadId,
        lastReadSequence: 0,
        revision: 0,
        updatedAtMs: 0,
      },
    );
  }

  private readStateMark(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const threadId = requiredString(params, "threadId");
    const messageCount = threadMessages(state, threadId).length;
    this.requireThread(state, threadId);
    const previous = state.humanReadStates.get(threadId);
    const expected = optionalSafeInteger(params, "expectedRevision");
    if (expected !== undefined && expected !== (previous?.revision ?? 0)) {
      throw new Error("read-state-revision-mismatch");
    }
    const upTo = Math.min(
      requiredSafeInteger(params, "upToSequence", "invalid-read-cursor"),
      messageCount,
    );
    if (previous && upTo <= previous.lastReadSequence) {
      return jsonResult(previous);
    }
    const result: ChatThreadReadState = {
      workspaceId: workspace,
      threadId,
      lastReadSequence: upTo,
      revision: (previous?.revision ?? 0) + 1,
      updatedAtMs: this.tick(optionalSafeInteger(params, "nowMs")),
    };
    state.humanReads.set(threadId, upTo);
    state.humanReadStates.set(threadId, result);
    return jsonResult(result);
  }

  private insertMessage(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
    threadId: string,
    atMs: number,
  ): ChatMessage {
    const messageId = requiredString(params, "messageId", "invalid-message-body");
    if (state.messages.has(messageId)) throw new Error("target-exists");
    const authorKind = requiredString(params, "authorKind", "invalid-sender");
    if (authorKind !== "human" && authorKind !== "agent") throw new Error("invalid-sender");
    const origin = optionalString(params, "origin");
    if (origin !== undefined && origin !== "cli") throw new Error("invalid-message-body");
    const body = normalizeMessageBody(requiredString(params, "body", "invalid-message-body"));
    const author: ChatActor = {
      kind: authorKind,
      displayName: normalizeNonempty(
        requiredString(params, "authorDisplayName", "invalid-sender"),
        "invalid-sender",
      ),
    };
    const message: ChatMessage = {
      id: messageId,
      workspaceId: workspace,
      threadId,
      author,
      body,
      createdAtMs: atMs,
      attachments: [],
    };
    const authorUserId = optionalString(params, "authorUserId");
    const parentMessageId = optionalString(params, "parentMessageId");
    if (authorUserId !== undefined) message.authorUserId = authorUserId;
    if (
      parentMessageId !== undefined &&
      state.messages.get(parentMessageId)?.threadId !== threadId
    ) {
      throw new Error("message-not-found");
    }
    if (parentMessageId !== undefined) message.parentMessageId = parentMessageId;
    if (origin === "cli") message.origin = "cli";
    const attachmentValues = params.attachments;
    if (attachmentValues !== undefined) {
      if (!Array.isArray(attachmentValues)) throw new Error("invalid-parameters");
      const seen = new Set<string>();
      for (const [index, value] of attachmentValues.entries()) {
        const attachment = this.localAttachment(value, threadId, messageId, atMs, index);
        const dedup = `${attachment.objectId}\0${attachment.headingAnchor ?? ""}\0${attachment.headingOccurrence ?? ""}`;
        if (seen.has(dedup)) continue;
        seen.add(dedup);
        message.attachments.push(attachment);
        state.attachments.set(attachment.attachmentId, attachment);
      }
    }
    state.messages.set(messageId, message);
    const ids = state.threadMessages.get(threadId) ?? [];
    ids.push(messageId);
    state.threadMessages.set(threadId, ids);
    for (const handle of mentionHandles(body)) {
      state.mentions.push({
        threadId,
        messageId,
        handle,
        authorKind,
        createdAtMs: atMs,
      });
    }
    if (optionalBoolean(params, "needsDecision") === true) {
      state.decisions.set(messageId, {
        threadId,
        messageId,
        state: "open",
        atMs,
      });
    }
    return message;
  }

  private localAttachment(
    value: JsonValue,
    threadId: string,
    messageId: string,
    atMs: number,
    index: number,
  ): ChatAttachment {
    const label = `attachments[${index}]`;
    const input = strictObject(value, label, [
      "objectId", "pathHint", "headingText", "headingAnchor", "headingOccurrence",
    ]) as ChatLocalAttachmentParams;
    const objectId = normalizeNonempty(requiredString(input, "objectId", "invalid-path"), "invalid-path");
    const pathHint = optionalString(input, "pathHint");
    const headingText = optionalString(input, "headingText");
    const headingAnchor = optionalString(input, "headingAnchor");
    const headingOccurrence = optionalSafeInteger(input, "headingOccurrence");
    const headingCount = [headingText, headingAnchor, headingOccurrence].filter(
      (entry) => entry !== undefined,
    ).length;
    if (headingCount !== 0 && headingCount !== 3) throw new Error("invalid-path");
    const attachment: ChatAttachment = {
      attachmentId: attachmentId(messageId, objectId, headingAnchor, headingOccurrence),
      threadId,
      messageId,
      targetKind: "file",
      objectId,
      createdAtMs: atMs,
    };
    if (pathHint !== undefined) attachment.pathHint = normalizePath(pathHint);
    if (headingText !== undefined) attachment.headingText = normalizeNonempty(headingText, "invalid-path");
    if (headingAnchor !== undefined) attachment.headingAnchor = normalizeNonempty(headingAnchor, "invalid-path");
    if (headingOccurrence !== undefined) attachment.headingOccurrence = headingOccurrence;
    return attachment;
  }

  private threadsListForFile(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const objectId = normalizeNonempty(requiredString(params, "objectId", "invalid-path"), "invalid-path");
    const rows = [...state.threads.values()]
      .filter((thread) => thread.workspaceId === workspace && thread.linkedFile?.objectId === objectId)
      .sort((left, right) => left.createdAtMs - right.createdAtMs || compareText(left.id, right.id));
    const result = page(rows, params, `${workspace}\0threadsForFile\0${objectId}`);
    return jsonResult({ threads: result.values, nextCursor: result.nextCursor });
  }

  private threadsListForChannel(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const channelId = requiredString(params, "channelId");
    if (!state.channels.has(channelId)) throw new Error("channel-not-found");
    const rows = [...state.threads.values()]
      .filter((thread) => thread.channelId === channelId)
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs || compareText(right.id, left.id))
      .map((thread) => {
        const messages = threadMessages(state, thread.id);
        const lastReadSequence = Math.min(
          state.humanReads.get(thread.id) ?? 0,
          messages.length,
        );
        const opening = messages[0];
        return {
          thread,
          messageCount: messages.length,
          lastReadSequence,
          unreadCount: messages.length - lastReadSequence,
          openDecisionCount: [...state.decisions.values()].filter(
            (decision) => decision.threadId === thread.id && decision.state === "open" &&
              state.messages.has(decision.messageId),
          ).length,
          ...(opening
            ? {
                openingMessage: {
                  id: opening.id,
                  author: opening.author,
                  createdAtMs: opening.createdAtMs,
                  bodySnippet:
                    opening.body.length > 500
                      ? `${opening.body.slice(0, 500).trimEnd()}…`
                      : opening.body,
                  reactions: activeMessageReactions(state, opening.id),
                },
              }
            : {}),
        };
      });
    const result = page(rows, params, `${workspace}\0threadsForChannel\0${channelId}`);
    return jsonResult({ threads: result.values, nextCursor: result.nextCursor });
  }

  private threadFindChannelId(state: WorkspaceState, params: ChatsJsonObject): JsonValue {
    const threadId = requiredString(params, "threadId", "invalid-parameters");
    if (threadId.length === 0 || threadId.length > 256 || /[\u0000-\u001f\u007f]/u.test(threadId)) {
      throw new Error("invalid-parameters");
    }
    return jsonResult(state.threads.get(threadId)?.channelId ?? null);
  }

  private threadProjection(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const thread = this.requireThread(state, requiredString(params, "threadId"));
    let access: ChatProjectionFileAccess = { kind: "unknown" };
    if (params.linkedFileAccess !== undefined) {
      const object = asObject(params.linkedFileAccess, "linkedFileAccess");
      const kind = requiredString(object, "kind", "invalid-path");
      if (kind === "allowed") {
        strictObject(params.linkedFileAccess, "linkedFileAccess", ["kind", "path"]);
        access = { kind: "allowed", path: normalizePath(requiredString(object, "path", "invalid-path")) };
      } else if (kind === "denied" || kind === "unknown") {
        strictObject(params.linkedFileAccess, "linkedFileAccess", ["kind"]);
        access = { kind };
      } else {
        throw new Error("invalid-path");
      }
    }
    const lines = [`# ${thread.title}`, "", "Read-only chat projection.", ""];
    if (thread.linkedFile) {
      lines.push(access.kind === "allowed" ? `Linked file: ${access.path}` : "Linked file: unavailable");
      lines.push("");
    }
    for (const message of threadMessages(state, thread.id)) {
      const author = message.author.kind === "agent"
        ? `${message.author.displayName} (agent)`
        : message.author.displayName;
      lines.push(`## ${author}`, "", message.body, "");
    }
    const text = `${lines.join("\n").trimEnd()}\n`;
    if (Buffer.byteLength(text, "utf8") > INBAND_CONTENT_CAP_BYTES) {
      throw new Error("projection-exceeds-inband-limit");
    }
    return jsonResult({
      path: projectionPath(workspace, thread.id),
      readOnly: true,
      threadId: thread.id,
      text,
    });
  }

  private decisionResolve(state: WorkspaceState, params: ChatsJsonObject): JsonValue {
    const threadId = requiredString(params, "threadId");
    this.requireThread(state, threadId);
    const messageId = requiredString(params, "messageId");
    const decision = state.decisions.get(messageId);
    if (!decision || decision.threadId !== threadId) throw new Error("decision-not-found");
    const resolvedByMessageId = normalizeNonempty(
      requiredString(params, "resolvedByMessageId", "invalid-message-body"),
      "invalid-message-body",
    );
    if (decision.state === "resolved") return jsonResult(decision);
    decision.state = "resolved";
    decision.resolvedByMessageId = resolvedByMessageId;
    decision.atMs = Math.max(this.tick(optionalSafeInteger(params, "nowMs")), decision.atMs + 1);
    return jsonResult(decision);
  }

  private decisionsList(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const threadId = requiredString(params, "threadId");
    this.requireThread(state, threadId);
    const rows = [...state.decisions.values()]
      .filter((decision) => decision.threadId === threadId && state.messages.has(decision.messageId))
      .sort((left, right) => left.atMs - right.atMs || compareText(left.messageId, right.messageId));
    const result = page(rows, params, `${workspace}\0decisions\0${threadId}`);
    return jsonResult({ decisions: result.values, nextCursor: result.nextCursor });
  }

  private reactionSet(state: WorkspaceState, params: ChatsJsonObject): JsonValue {
    const threadId = requiredString(params, "threadId");
    this.requireThread(state, threadId);
    const messageId = requiredString(params, "messageId");
    const message = state.messages.get(messageId);
    if (!message || message.threadId !== threadId) throw new Error("message-not-found");
    const emoji = validateEmoji(requiredString(params, "emoji", "invalid-message-body"));
    const authorInput = strictObject(params.author ?? null, "author", [
      "authorId", "kind", "displayName",
    ]);
    const authorId = normalizeNonempty(requiredString(authorInput, "authorId", "invalid-sender"), "invalid-sender");
    const kind = requiredString(authorInput, "kind", "invalid-sender");
    if (kind !== "human" && kind !== "agent") throw new Error("invalid-sender");
    const stateValue = requiredString(params, "state", "invalid-parameters");
    if (stateValue !== "added" && stateValue !== "removed") throw new Error("invalid-parameters");
    const key = reactionCellKey(messageId, emoji, authorId);
    const prior = state.reactions.get(key);
    const reaction: ChatReaction = {
      reactionId: reactionId(messageId, emoji, authorId),
      threadId,
      messageId,
      emoji,
      author: {
        authorId,
        kind,
        displayName: normalizeNonempty(
          requiredString(authorInput, "displayName", "invalid-sender"),
          "invalid-sender",
        ),
      },
      state: stateValue,
      // MUTATION: removing the per-cell +1 bump lets a stale/equal local time lose.
      atMs: Math.max(this.tick(optionalSafeInteger(params, "nowMs")), (prior?.atMs ?? -1) + 1),
    };
    state.reactions.set(key, reaction);
    return jsonResult(reaction);
  }

  private reactionsList(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const threadId = requiredString(params, "threadId");
    this.requireThread(state, threadId);
    const rows = [...state.reactions.values()]
      .filter(
        (reaction) =>
          reaction.threadId === threadId &&
          reaction.state === "added" &&
          state.messages.has(reaction.messageId),
      )
      .sort((left, right) => left.atMs - right.atMs || compareText(left.reactionId, right.reactionId));
    const result = page(rows, params, `${workspace}\0reactions\0${threadId}`);
    return jsonResult({ reactions: result.values, nextCursor: result.nextCursor });
  }

  private attachmentsList(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const threadId = requiredString(params, "threadId");
    this.requireThread(state, threadId);
    const rows = [...state.attachments.values()]
      .filter((attachment) => attachment.threadId === threadId && state.messages.has(attachment.messageId))
      .sort(
        (left, right) =>
          left.createdAtMs - right.createdAtMs || compareText(left.attachmentId, right.attachmentId),
      );
    const result = page(rows, params, `${workspace}\0attachments\0${threadId}`);
    return jsonResult({ attachments: result.values, nextCursor: result.nextCursor });
  }

  private fileMentions(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const objectId = optionalString(params, "objectId")?.trim();
    const pathHintInput = optionalString(params, "pathHint");
    const pathHint = pathHintInput === undefined ? undefined : normalizePath(pathHintInput);
    if (!objectId && !pathHint) throw new Error("invalid-path");
    const rows = [...state.attachments.values()]
      .filter((attachment) =>
        objectId ? attachment.objectId === objectId : attachment.pathHint === pathHint)
      .filter((attachment) => state.messages.has(attachment.messageId))
      .sort(
        (left, right) =>
          right.createdAtMs - left.createdAtMs || compareText(right.attachmentId, left.attachmentId),
      )
      .slice(0, 2_000)
      .map((attachment) => {
        const message = state.messages.get(attachment.messageId)!;
        const thread = state.threads.get(attachment.threadId);
        if (!thread) throw new Error("state-corrupt");
        const channel = thread.channelId ? state.channels.get(thread.channelId) : undefined;
        return {
          attachment,
          message,
          thread,
          ...(channel
            ? {
                channel: {
                  workspaceId: channel.workspaceId,
                  channelId: channel.channelId,
                  name: channel.name,
                  slug: channel.slug,
                  kind: channel.kind,
                  createdAtMs: channel.createdAtMs,
                  updatedAtMs: channel.updatedAtMs,
                },
              }
            : {}),
        };
      });
    const selector = objectId ? `object:${objectId}` : `path:${pathHint}`;
    const result = page(rows, params, `${workspace}\0fileMentions\0${selector}`);
    return jsonResult({ mentions: result.values, nextCursor: result.nextCursor });
  }

  private mentionsList(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const handle = requiredString(params, "handle", "invalid-message-body").trim().toLowerCase();
    if (!/^[a-z0-9-]+$/u.test(handle)) throw new Error("invalid-message-body");
    const unreadOnly = optionalBoolean(params, "unreadByAgentOnly") ?? false;
    const rows = state.mentions
      .filter((mention) => mention.handle === handle)
      .filter((mention) => state.messages.has(mention.messageId) && state.threads.has(mention.threadId))
      .filter((mention) => {
        if (!unreadOnly) return true;
        const read = state.agentReads.get(mention.threadId);
        return !read ||
          mention.createdAtMs > read.lastReadCreatedAtMs ||
          (
            mention.createdAtMs === read.lastReadCreatedAtMs &&
            compareText(mention.messageId, read.lastReadMessageId) > 0
          );
      })
      .sort((left, right) => left.createdAtMs - right.createdAtMs || compareText(left.messageId, right.messageId));
    const result = page(rows, params, `${workspace}\0mentions\0${handle}\0${unreadOnly}`);
    return jsonResult({ mentions: result.values, nextCursor: result.nextCursor });
  }

  private agentUnreadThreads(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const rows = [...state.threads.values()]
      .map((thread) => ({
        thread,
        latest: threadMessages(state, thread.id).at(-1),
      }))
      .filter((entry): entry is { thread: ChatThread; latest: ChatMessage } => {
        if (!entry.latest || entry.latest.author.kind !== "human") return false;
        const read = state.agentReads.get(entry.thread.id);
        return !read ||
          entry.latest.createdAtMs > read.lastReadCreatedAtMs ||
          (
            entry.latest.createdAtMs === read.lastReadCreatedAtMs &&
            compareText(entry.latest.id, read.lastReadMessageId) > 0
          );
      })
      .sort(
        (left, right) =>
          right.latest.createdAtMs - left.latest.createdAtMs ||
          compareText(right.latest.id, left.latest.id),
      )
      .map((entry) => entry.thread);
    const result = page(rows, params, `${workspace}\0agentUnread`);
    return jsonResult({ threads: result.values, nextCursor: result.nextCursor });
  }

  private agentMarkRead(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const threadId = requiredString(params, "threadId");
    this.requireThread(state, threadId);
    const upTo = strictObject(params.upTo ?? null, "upTo", ["createdAtMs", "messageId"]);
    const requested = {
      createdAtMs: requiredSafeInteger(upTo, "createdAtMs", "invalid-read-cursor"),
      messageId: requiredString(upTo, "messageId", "invalid-read-cursor"),
    };
    const prior = state.agentReads.get(threadId);
    const expected = optionalSafeInteger(params, "expectedRevision");
    if (expected !== undefined && expected !== (prior?.revision ?? 0)) {
      throw new Error("read-state-revision-mismatch");
    }
    const messages = threadMessages(state, threadId);
    const latest = messages.at(-1);
    const clamped = latest && (
      requested.createdAtMs > latest.createdAtMs ||
      (
        requested.createdAtMs === latest.createdAtMs &&
        compareText(requested.messageId, latest.id) > 0
      )
    )
      ? { createdAtMs: latest.createdAtMs, messageId: latest.id }
      : requested;
    const advances = !prior ||
      clamped.createdAtMs > prior.lastReadCreatedAtMs ||
      (
        clamped.createdAtMs === prior.lastReadCreatedAtMs &&
        compareText(clamped.messageId, prior.lastReadMessageId) > 0
      );
    const result: ChatAgentReadState = advances
      ? {
          workspaceId: workspace,
          threadId,
          lastReadCreatedAtMs: clamped.createdAtMs,
          lastReadMessageId: clamped.messageId,
          revision: (prior?.revision ?? 0) + 1,
          updatedAtMs: this.tick(),
        }
      : prior ?? {
          workspaceId: workspace,
          threadId,
          lastReadCreatedAtMs: 0,
          lastReadMessageId: "",
          revision: 0,
          updatedAtMs: 0,
        };
    state.agentReads.set(threadId, result);
    return jsonResult(result);
  }

  private followSet(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const ownerUserId = normalizeTrimmed(
      requiredString(params, "ownerUserId", "invalid-follow-target"),
      "invalid-follow-target",
    );
    const replicationOwner = optionalString(
      params,
      "replicationOwnerUserId",
    );
    const replicationOwnerUserId = replicationOwner === undefined
      ? undefined
      : normalizeTrimmed(replicationOwner, "invalid-follow-target");
    if (
      replicationOwnerUserId !== undefined &&
      replicationOwnerUserId !== ownerUserId
    ) {
      throw new Error("invalid-follow-target");
    }
    const targetKind = requiredString(params, "targetKind");
    if (!["person", "agent", "channel", "thread"].includes(targetKind)) {
      throw new Error("invalid-follow-target");
    }
    const targetId = requiredString(
      params,
      "targetId",
      "invalid-follow-target",
    );
    const followState = requiredString(params, "state");
    if (followState !== "following" && followState !== "unfollowed") {
      throw new Error("invalid-follow-target");
    }
    const key = `${ownerUserId}\0${targetKind}\0${targetId}`;
    const record: ChatFollow = {
      workspaceId: workspace,
      ownerUserId,
      targetKind: targetKind as ChatFollow["targetKind"],
      targetId,
      state: followState,
      updatedAtMs: this.tick(optionalSafeInteger(params, "nowMs")),
    };
    state.followRecords.set(key, record);
    const follows = state.follows.get(ownerUserId) ?? new Set<string>();
    const target = `${targetKind}\0${targetId}`;
    if (followState === "following") follows.add(target);
    else follows.delete(target);
    state.follows.set(ownerUserId, follows);
    return jsonResult(record);
  }

  private followsList(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const ownerUserId = requiredString(
      params,
      "ownerUserId",
      "invalid-follow-target",
    );
    const wantedState = optionalString(params, "state");
    if (
      wantedState !== undefined &&
      wantedState !== "following" &&
      wantedState !== "unfollowed"
    ) {
      throw new Error("invalid-follow-target");
    }
    const follows = [...state.followRecords.values()]
      .filter(
        (follow) =>
          follow.workspaceId === workspace &&
          follow.ownerUserId === ownerUserId &&
          (wantedState === undefined || follow.state === wantedState),
      )
      .sort(
        (left, right) =>
          left.updatedAtMs - right.updatedAtMs ||
          compareText(left.targetId, right.targetId),
      );
    return jsonResult({ follows, truncated: false });
  }

  private ensureDefaultFollows(state: WorkspaceState, params: ChatsJsonObject): JsonValue {
    const owner = normalizeTrimmed(
      requiredString(params, "ownerUserId", "invalid-follow-target"),
      "invalid-follow-target",
    );
    const follows = state.follows.get(owner) ?? new Set<string>();
    for (const channel of state.channels.values()) {
      if (channel.kind !== "dm" && channel.wireId) follows.add(`channel\0${channel.wireId}`);
    }
    state.follows.set(owner, follows);
    return null;
  }

  private feedMarkSeen(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const ownerUserId = normalizeTrimmed(
      requiredString(params, "ownerUserId", "invalid-follow-target"),
      "invalid-follow-target",
    );
    const replicationOwner = optionalString(
      params,
      "replicationOwnerUserId",
    );
    const replicationOwnerUserId = replicationOwner === undefined
      ? undefined
      : normalizeTrimmed(replicationOwner, "invalid-follow-target");
    if (
      replicationOwnerUserId !== undefined &&
      replicationOwnerUserId !== ownerUserId
    ) {
      throw new Error("invalid-follow-target");
    }
    const cursor = decodeFeedCursor(
      requiredString(params, "headCursor", "invalid-follow-target"),
    );
    const visible = personalFeedMessages(state, workspace, ownerUserId).some(
      (message) =>
        message.createdAtMs === cursor.createdAtMs &&
        message.id === cursor.messageId,
    );
    if (!visible) throw new Error("invalid-follow-target");

    const prior = state.feedReads.get(ownerUserId);
    const requestedAtMs = this.tick(optionalSafeInteger(params, "nowMs"));
    const candidate: ChatFeedReadState = {
      workspaceId: workspace,
      ownerUserId,
      lastSeenCreatedAtMs: cursor.createdAtMs,
      lastSeenMessageId: cursor.messageId,
      updatedAtMs: Math.max(
        requestedAtMs,
        (prior?.updatedAtMs ?? -1) + 1,
      ),
    };
    const advances =
      prior === undefined ||
      candidate.lastSeenCreatedAtMs > prior.lastSeenCreatedAtMs ||
      (
        candidate.lastSeenCreatedAtMs === prior.lastSeenCreatedAtMs &&
        compareText(candidate.lastSeenMessageId, prior.lastSeenMessageId) >= 0
      );
    const result = advances ? candidate : prior;
    state.feedReads.set(ownerUserId, result);
    return jsonResult(result);
  }

  private feedList(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const owner = requiredString(params, "ownerUserId", "invalid-follow-target");
    const follows = state.follows.get(owner) ?? new Set<string>();
    const feedMessages = personalFeedMessages(state, workspace, owner);
    const candidates: ChatFeedItem[] = feedMessages
      .map((message) => {
        const thread = state.threads.get(message.threadId)!;
        const channel = thread.channelId ? state.channels.get(thread.channelId) : undefined;
        const isOpeningMessage = threadMessages(state, thread.id)[0]?.id === message.id;
        const matchedBy: ChatFeedItem["matchedBy"] = [];
        if (
          message.authorUserId &&
          (
            (message.author.kind === "human" && follows.has(`person\0${message.authorUserId}`)) ||
            (message.author.kind === "agent" && follows.has(`agent\0${message.authorUserId}`))
          )
        ) {
          matchedBy.push(message.author.kind === "agent" ? "agent" : "person");
        }
        if (follows.has(`thread\0${thread.id}`)) matchedBy.push("thread");
        if (
          isOpeningMessage &&
          channel?.wireId !== null &&
          channel?.wireId !== undefined &&
          follows.has(`channel\0${channel.wireId}`)
        ) {
          matchedBy.push("channel");
        }
        const openingMessage = isOpeningMessage
          ? undefined
          : threadMessages(state, thread.id)[0];
        const parentMessage = message.parentMessageId
          ? state.messages.get(message.parentMessageId)
          : undefined;
        return {
          message,
          thread,
          reactions: activeMessageReactions(state, message.id),
          matchedBy,
          ...(parentMessage ? { parentMessage } : {}),
          ...(openingMessage ? { openingMessage } : {}),
          ...(channel
            ? {
                channel: {
                  id: channel.channelId,
                  workspaceId: channel.workspaceId,
                  name: channel.name,
                  slug: channel.slug,
                  kind: channel.kind,
                  createdAtMs: channel.createdAtMs,
                  updatedAtMs: channel.updatedAtMs,
                },
              }
            : {}),
        };
      });
    const limit = optionalSafeInteger(params, "limit", 1) ?? 20;
    if (limit > 100) throw new Error("invalid-follow-target");
    const cursorParams: ChatsJsonObject = {
      pageLimit: limit,
      ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
    };
    const result = page(candidates, cursorParams, `${workspace}\0feed\0${owner}`);
    const head = candidates[0];
    return jsonResult({
      items: result.values,
      nextCursor: result.nextCursor,
      headCursor: head ? encodeFeedCursor(head.message) : null,
      readState: state.feedReads.get(owner) ?? null,
    });
  }

  private bookmarkSave(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const ownerUserId = requiredString(
      params,
      "ownerUserId",
      "invalid-follow-target",
    );
    const targetKind = requiredString(params, "targetKind");
    if (targetKind !== "message" && targetKind !== "thread") {
      throw new Error("invalid-bookmark-target");
    }
    const targetId = requiredString(
      params,
      "targetId",
      "invalid-bookmark-target",
    );
    const mode = requiredString(params, "mode");
    if (mode !== "live" && mode !== "snapshot") {
      throw new Error("invalid-bookmark-target");
    }
    const destinationPath = normalizeTrackedPath(
      requiredString(params, "destinationPath", "invalid-path"),
    );
    const thread =
      targetKind === "thread"
        ? this.requireThread(state, targetId)
        : this.requireThread(
            state,
            state.messages.get(targetId)?.threadId ?? "",
          );
    const atMs = this.tick(optionalSafeInteger(params, "nowMs"));
    const existing = [...state.bookmarks.values()].find(
      (bookmark) =>
        bookmark.ownerUserId === ownerUserId &&
        bookmark.targetKind === targetKind &&
        bookmark.targetId === targetId,
    );
    if (existing) {
      const resetsProjection =
        existing.destinationPath !== destinationPath ||
        existing.state === "archived";
      existing.threadId = thread.id;
      if (targetKind === "message") existing.messageId = targetId;
      else delete existing.messageId;
      existing.mode = mode;
      existing.destinationPath = destinationPath;
      existing.state = "active";
      existing.generation += 1;
      existing.projectionState = "pending";
      delete existing.failureReason;
      if (resetsProjection) delete existing.projectionObjectId;
      existing.updatedAtMs = atMs;
      return jsonResult(existing);
    }
    const bookmark: ChatBookmark = {
      bookmarkId: bookmarkId(ownerUserId, targetKind, targetId),
      workspaceId: workspace,
      ownerUserId,
      targetKind,
      targetId,
      threadId: thread.id,
      ...(targetKind === "message" ? { messageId: targetId } : {}),
      mode,
      destinationPath,
      state: "active",
      generation: 1,
      projectedGeneration: 0,
      projectionState: "pending",
      createdAtMs: atMs,
      updatedAtMs: atMs,
    };
    state.bookmarks.set(bookmarkKey(ownerUserId, bookmark.bookmarkId), bookmark);
    return jsonResult(bookmark);
  }

  private bookmarksList(
    state: WorkspaceState,
    params: ChatsJsonObject,
  ): JsonValue {
    const ownerUserId = requiredString(
      params,
      "ownerUserId",
      "invalid-follow-target",
    );
    const wantedState = optionalString(params, "state");
    if (
      wantedState !== undefined &&
      wantedState !== "active" &&
      wantedState !== "archived"
    ) {
      throw new Error("invalid-bookmark-target");
    }
    const bookmarks = [...state.bookmarks.values()]
      .filter(
        (bookmark) =>
          bookmark.ownerUserId === ownerUserId &&
          (wantedState === undefined || bookmark.state === wantedState),
      )
      .sort(
        (left, right) =>
          left.createdAtMs - right.createdAtMs ||
          compareText(left.bookmarkId, right.bookmarkId),
      );
    return jsonResult({ bookmarks, truncated: false });
  }

  private bookmarkFind(state: WorkspaceState, params: ChatsJsonObject): JsonValue {
    const owner = requiredString(params, "ownerUserId", "invalid-follow-target");
    const id = requiredString(params, "bookmarkId", "invalid-bookmark-target");
    return jsonResult(state.bookmarks.get(bookmarkKey(owner, id)) ?? null);
  }

  private bookmarkListPending(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const owner = requiredString(params, "ownerUserId", "invalid-follow-target");
    const logicalLimit = optionalSafeInteger(params, "limit", 1) ?? 50;
    if (logicalLimit > 200) throw new Error("invalid-parameters");
    const rows = [...state.bookmarks.values()]
      .filter((bookmark) =>
        bookmark.ownerUserId === owner &&
        bookmark.state === "active" &&
        bookmark.projectionState === "pending")
      .sort((left, right) => left.updatedAtMs - right.updatedAtMs || compareText(left.bookmarkId, right.bookmarkId))
      .slice(0, logicalLimit);
    const result = page(rows, params, `${workspace}\0pendingBookmarks\0${owner}\0${logicalLimit}`);
    return jsonResult({ bookmarks: result.values, nextCursor: result.nextCursor });
  }

  private bookmarkMarkReady(
    state: WorkspaceState,
    params: ChatsJsonObject,
  ): JsonValue {
    const bookmark = this.requireBookmark(state, params);
    const generation = requiredSafeInteger(
      params,
      "generation",
      "invalid-bookmark-target",
    );
    const applied =
      bookmark.generation === generation &&
      bookmark.state === "active" &&
      bookmark.projectionState === "pending";
    const projectionObjectId = optionalString(
      params,
      "projectionObjectId",
    );
    const projectionPath = optionalString(params, "projectionPath");
    if (
      (projectionObjectId === undefined) !== (projectionPath === undefined)
    ) {
      throw new Error("invalid-bookmark-target");
    }
    const projectionIdentity =
      projectionObjectId === undefined || projectionPath === undefined
        ? undefined
        : {
            objectId: normalizeTrimmed(
              projectionObjectId,
              "invalid-bookmark-target",
            ),
            path: validateProjectionPath(projectionPath),
          };
    if (
      projectionIdentity !== undefined &&
      (
        projectionIdentity.objectId.length > 256 ||
        /[\u0000-\u001f\u007f]/u.test(projectionIdentity.objectId)
      )
    ) {
      throw new Error("invalid-bookmark-target");
    }
    if (applied) {
      if (
        projectionIdentity !== undefined &&
        (
          projectionIdentity.path !== bookmark.destinationPath ||
          (
            bookmark.projectionObjectId !== undefined &&
            bookmark.projectionObjectId !== projectionIdentity.objectId
          )
        )
      ) {
        throw new Error("invalid-bookmark-target");
      }
      bookmark.projectionState = "ready";
      bookmark.projectedGeneration = generation;
      bookmark.lastProjectedAtMs =
        optionalSafeInteger(params, "projectedAtMs") ?? this.tick();
      if (projectionIdentity !== undefined) {
        bookmark.projectionObjectId = projectionIdentity.objectId;
      }
      delete bookmark.failureReason;
      bookmark.updatedAtMs = bookmark.lastProjectedAtMs;
    }
    return jsonResult({ bookmark, applied });
  }

  private requireBookmark(state: WorkspaceState, params: ChatsJsonObject): ChatBookmark {
    const owner = requiredString(params, "ownerUserId", "invalid-follow-target");
    const id = requiredString(params, "bookmarkId", "invalid-bookmark-target");
    const bookmark = state.bookmarks.get(bookmarkKey(owner, id));
    if (!bookmark) throw new Error("invalid-bookmark-target");
    return bookmark;
  }

  private bookmarkArchive(state: WorkspaceState, params: ChatsJsonObject): JsonValue {
    const bookmark = this.requireBookmark(state, params);
    if (bookmark.state === "active") {
      bookmark.state = "archived";
      bookmark.generation += 1;
      bookmark.projectionState = "pending";
      bookmark.updatedAtMs = this.tick();
    }
    return jsonResult(bookmark);
  }

  private bookmarkMarkPending(state: WorkspaceState, params: ChatsJsonObject): JsonValue {
    const bookmark = this.requireBookmark(state, params);
    bookmark.generation += 1;
    bookmark.projectionState = "pending";
    delete bookmark.failureReason;
    bookmark.updatedAtMs = this.tick();
    return jsonResult(bookmark);
  }

  private bookmarkTransition(
    state: WorkspaceState,
    params: ChatsJsonObject,
    projectionState: "failed" | "stale",
  ): JsonValue {
    const bookmark = this.requireBookmark(state, params);
    const generation = requiredSafeInteger(params, "generation", "invalid-bookmark-target");
    const applied =
      bookmark.generation === generation &&
      bookmark.state === "active" &&
      bookmark.projectionState === "pending";
    if (applied) {
      bookmark.projectionState = projectionState;
      const reason = optionalString(params, "failureReason")?.trim();
      if (reason) bookmark.failureReason = reason;
      else delete bookmark.failureReason;
      bookmark.updatedAtMs = this.tick();
    }
    return jsonResult({ bookmark, applied });
  }

  private dispatchEnqueue(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const triggerMessageId = requiredString(params, "triggerMessageId");
    const threadId = requiredString(params, "threadId");
    this.requireThread(state, threadId);
    if (state.dispatches.has(triggerMessageId)) {
      return jsonResult({ enqueued: false });
    }
    const atMs = this.tick(optionalSafeInteger(params, "nowMs"));
    state.dispatches.set(triggerMessageId, {
      workspaceId: workspace,
      triggerMessageId,
      threadId,
      state: "pending",
      attemptCount: 0,
      createdAtMs: atMs,
      updatedAtMs: atMs,
    });
    return jsonResult({ enqueued: true });
  }

  private recordEligibleTriggers(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const verified = optionalString(params, "verifiedUserId");
    const atMs = this.tick();
    let inserted = 0;
    const messages = [...state.messages.values()].sort(
      (left, right) => left.createdAtMs - right.createdAtMs || compareText(left.id, right.id),
    );
    for (const message of messages) {
      if (message.createdAtMs < Math.max(-1, state.scanHighWaterMs - 1)) continue;
      const thread = state.threads.get(message.threadId);
      const channel = thread?.channelId ? state.channels.get(thread.channelId) : undefined;
      const mentionsAgent = state.mentions.some(
        (mention) => mention.messageId === message.id && mention.handle === "agent",
      );
      const authoredByVerified =
        message.authorUserId === undefined ||
        (verified !== undefined && verified === message.authorUserId);
      const eligible =
        message.author.kind === "human" &&
        message.origin !== "cli" &&
        authoredByVerified &&
        (channel?.kind === "agent" || mentionsAgent);
      if (eligible && !state.dispatches.has(message.id)) {
        state.dispatches.set(message.id, {
          workspaceId: workspace,
          triggerMessageId: message.id,
          threadId: message.threadId,
          state: "pending",
          attemptCount: 0,
          createdAtMs: message.createdAtMs,
          updatedAtMs: atMs,
        });
        inserted += 1;
      }
      state.scanHighWaterMs = Math.max(state.scanHighWaterMs, message.createdAtMs);
    }
    // MUTATION: replacing the ledger insert-if-absent with overwrite makes retry count nonzero.
    return jsonResult(inserted);
  }

  private claimNextPending(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const runId = normalizeNonempty(requiredString(params, "runId"), "invalid-input");
    const existingRun = state.runs.get(runId);
    if (existingRun) {
      const existingDispatch = [...state.dispatches.values()].find(
        (row) => row.state === "running" && row.runId === runId,
      );
      if (existingRun.endedAtMs === undefined && existingDispatch) {
        return jsonResult({ dispatch: existingDispatch, run: existingRun });
      }
      throw new Error("invalid-input");
    }
    if (
      [...this.workspaces.entries()].some(
        ([workspaceId, candidate]) => workspaceId !== workspace && candidate.runs.has(runId),
      )
    ) {
      throw new Error("invalid-input");
    }
    if ([...state.dispatches.values()].some((row) => row.state === "running")) return null;
    const dispatch = [...state.dispatches.values()]
      .filter((row) => row.state === "pending" && !(state.pauses.get(row.threadId)?.paused ?? false))
      .sort((left, right) => left.createdAtMs - right.createdAtMs || compareText(left.triggerMessageId, right.triggerMessageId))[0];
    if (!dispatch) return null;
    const atMs = this.tick(optionalSafeInteger(params, "nowMs"));
    dispatch.state = "running";
    dispatch.runId = runId;
    dispatch.attemptCount += 1;
    dispatch.updatedAtMs = atMs;
    for (const other of state.dispatches.values()) {
      if (other.threadId === dispatch.threadId && other.state === "pending") {
        other.state = "done";
        other.runId = runId;
        other.attemptCount += 1;
        other.updatedAtMs = atMs;
      }
    }
    const run: ChatRun = {
      workspaceId: workspace,
      runId,
      threadId: dispatch.threadId,
      triggerMessageId: dispatch.triggerMessageId,
      command: optionalString(params, "command") ?? "",
      startedAtMs: atMs,
      failureNotePosted: false,
    };
    const logPath = optionalString(params, "logPath");
    if (logPath !== undefined) run.logPath = logPath;
    state.runs.set(runId, run);
    return jsonResult({ dispatch, run });
  }

  private dispatchListPending(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const rows = [...state.dispatches.values()]
      .filter((dispatch) => dispatch.state === "pending")
      .sort((left, right) => left.createdAtMs - right.createdAtMs || compareText(left.triggerMessageId, right.triggerMessageId));
    const result = page(rows, params, `${workspace}\0dispatchPending`);
    return jsonResult({ dispatches: result.values, nextCursor: result.nextCursor });
  }

  private dispatchOpenRuns(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const claims: ChatDispatchClaim[] = [];
    const unended = [...state.runs.values()].filter((run) => run.endedAtMs === undefined);
    for (const dispatch of state.dispatches.values()) {
      if (dispatch.state !== "running") continue;
      const runs = unended.filter((run) =>
        run.runId === dispatch.runId && run.triggerMessageId === dispatch.triggerMessageId);
      if (runs.length !== 1) throw new Error("state-corrupt");
      claims.push({ dispatch, run: runs[0]! });
    }
    if (unended.some((run) => !claims.some((claim) => claim.run.runId === run.runId))) {
      throw new Error("state-corrupt");
    }
    claims.sort(
      (left, right) =>
        left.dispatch.updatedAtMs - right.dispatch.updatedAtMs ||
        compareText(left.dispatch.triggerMessageId, right.dispatch.triggerMessageId),
    );
    const result = page(claims, params, `${workspace}\0openRuns`);
    return jsonResult({ claims: result.values, nextCursor: result.nextCursor });
  }

  private listRunMessages(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const runId = requiredString(params, "runId");
    const rows = [...state.runLinks.entries()]
      .filter(([, linkedRunId]) => linkedRunId === runId)
      .map(([messageId]) => messageId)
      .sort(compareText);
    const result = page(rows, params, `${workspace}\0runMessages\0${runId}`);
    return jsonResult({ messageIds: result.values, nextCursor: result.nextCursor });
  }

  private runIdForMessage(state: WorkspaceState, params: ChatsJsonObject): JsonValue {
    return jsonResult(state.runLinks.get(requiredString(params, "messageId")) ?? null);
  }

  private runRecordsForThread(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const threadId = requiredString(params, "threadId");
    const limit = optionalSafeInteger(params, "limit", 1);
    let selectedRuns = [...state.runs.values()]
      .filter((run) => run.threadId === threadId)
      .sort((left, right) => right.startedAtMs - left.startedAtMs || compareText(right.runId, left.runId));
    if (limit !== undefined) selectedRuns = selectedRuns.slice(0, limit);
    const selectedIds = new Set(selectedRuns.map((run) => run.runId));
    const rows = [...state.runLinks.entries()]
      .filter(([, runId]) => selectedIds.has(runId))
      .map(([messageId, runId]) => ({ messageId, run: state.runs.get(runId)! }))
      .sort(
        (left, right) =>
          right.run.startedAtMs - left.run.startedAtMs ||
          compareText(right.run.runId, left.run.runId) ||
          compareText(left.messageId, right.messageId),
      );
    const result = page(rows, params, `${workspace}\0threadRuns\0${threadId}\0${limit ?? ""}`);
    const runs: Record<string, ChatRun> = {};
    for (const row of result.values) runs[row.messageId] = row.run;
    return jsonResult({ runs, nextCursor: result.nextCursor });
  }

  private getRunRecord(state: WorkspaceState, params: ChatsJsonObject): JsonValue {
    return jsonResult(state.runs.get(requiredString(params, "runId")) ?? null);
  }

  private recentCount(state: WorkspaceState, params: ChatsJsonObject): JsonValue {
    const threadId = requiredString(params, "threadId");
    const sinceMs = params.sinceMs;
    if (typeof sinceMs !== "number" || !Number.isFinite(sinceMs)) throw new Error("invalid-input");
    return jsonResult(
      [...state.runs.values()].filter(
        (run) => run.threadId === threadId && run.startedAtMs >= sinceMs,
      ).length,
    );
  }

  private failPending(state: WorkspaceState, params: ChatsJsonObject): JsonValue {
    const threadId = requiredString(params, "threadId");
    const reason = normalizeNonempty(requiredString(params, "reason"), "invalid-input");
    let changed = 0;
    for (const dispatch of state.dispatches.values()) {
      if (dispatch.threadId === threadId && dispatch.state === "pending") {
        dispatch.state = "failed";
        dispatch.failureReason = reason;
        dispatch.updatedAtMs = this.tick();
        changed += 1;
      }
    }
    return jsonResult(changed);
  }

  private dispatchComplete(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const runId = requiredString(params, "runId");
    const run = state.runs.get(runId);
    if (!run || run.workspaceId !== workspace) throw new Error("run-not-found");
    const dispatch = state.dispatches.get(run.triggerMessageId);
    if (!dispatch || dispatch.runId !== runId || dispatch.state !== "running") {
      throw new Error("run-state-mismatch");
    }
    const atMs = this.tick(optionalSafeInteger(params, "nowMs"));
    const exitCode = requiredInteger(params, "exitCode");
    run.endedAtMs = atMs;
    run.exitCode = exitCode;
    dispatch.state = "done";
    dispatch.updatedAtMs = atMs;
    return jsonResult({ completed: true });
  }

  private dispatchFail(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const runId = requiredString(params, "runId");
    const run = state.runs.get(runId);
    if (!run || run.workspaceId !== workspace) throw new Error("run-not-found");
    const dispatch = state.dispatches.get(run.triggerMessageId);
    if (!dispatch || dispatch.runId !== runId || dispatch.state !== "running") {
      throw new Error("run-state-mismatch");
    }
    const reason = normalizeNonempty(
      requiredString(params, "reason"),
      "invalid-input",
    );
    const atMs = this.tick(optionalSafeInteger(params, "nowMs"));
    run.endedAtMs = atMs;
    run.failureReason = reason;
    const exitCode = optionalInteger(params, "exitCode");
    if (exitCode !== undefined) run.exitCode = exitCode;
    dispatch.state = "failed";
    dispatch.failureReason = reason;
    dispatch.updatedAtMs = atMs;
    return jsonResult({ failed: true });
  }

  private recordRunMessage(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const messageId = requiredString(params, "messageId");
    const runId = requiredString(params, "runId");
    const run = state.runs.get(runId);
    if (!run || run.workspaceId !== workspace) throw new Error("run-not-found");
    const key = runLinkKey(messageId);
    const prior = state.runLinks.get(key);
    if (prior === runId) return jsonResult(false);
    if (prior !== undefined) throw new Error("state-corrupt");
    state.runLinks.set(key, runId);
    return jsonResult(true);
  }

  private setThreadPaused(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const paused = requiredBoolean(params, "paused");
    const reason = optionalString(params, "reason")?.trim();
    const pause: ChatThreadPause = {
      workspaceId: workspace,
      threadId: requiredString(params, "threadId"),
      paused,
      updatedAtMs: this.tick(),
    };
    if (paused && reason) pause.reason = reason;
    state.pauses.set(pause.threadId, pause);
    return jsonResult(pause);
  }

  private markFailureNotePosted(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const run = state.runs.get(requiredString(params, "runId"));
    if (!run || run.workspaceId !== workspace) throw new Error("run-not-found");
    run.failureNotePosted = true;
    return jsonResult(run);
  }

  private requeueFailed(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const triggerMessageId = requiredString(params, "triggerMessageId");
    const runId = requiredString(params, "runId");
    const run = state.runs.get(runId);
    const dispatch = state.dispatches.get(triggerMessageId);
    const applies =
      run?.workspaceId === workspace &&
      run.endedAtMs !== undefined &&
      dispatch?.state === "failed" &&
      dispatch.runId === runId &&
      dispatch.attemptCount < 2;
    if (!applies || !dispatch) return jsonResult(false);
    dispatch.state = "pending";
    delete dispatch.runId;
    delete dispatch.failureReason;
    dispatch.updatedAtMs = this.tick();
    return jsonResult(true);
  }

  private appQuitRecoveries(
    state: WorkspaceState,
    workspace: string,
    params: ChatsJsonObject,
  ): JsonValue {
    const rows = [...state.runs.values()]
      .filter((run) => {
        const dispatch = state.dispatches.get(run.triggerMessageId);
        return (
          run.workspaceId === workspace &&
          run.endedAtMs !== undefined &&
          run.exitCode === APP_QUIT_EXIT_CODE &&
          run.failureReason === "app-quit" &&
          !run.failureNotePosted &&
          dispatch?.state === "failed" &&
          dispatch.runId === run.runId
        );
      })
      .sort((left, right) => left.startedAtMs - right.startedAtMs || compareText(left.runId, right.runId))
      .map((run) => ({
        run,
        attemptCount: state.dispatches.get(run.triggerMessageId)?.attemptCount ?? 0,
      }));
    const result = page(rows, params, `${workspace}\0appQuitRecoveries`);
    return jsonResult({ recoveries: result.values, nextCursor: result.nextCursor });
  }

  private readSequence(messages: ChatMessage[], read: ChatAgentReadState): number {
    return messages.filter(
      (message) =>
        message.createdAtMs < read.lastReadCreatedAtMs ||
        (
          message.createdAtMs === read.lastReadCreatedAtMs &&
          compareText(message.id, read.lastReadMessageId) <= 0
        ),
    ).length;
  }

  private requireThread(state: WorkspaceState, threadId: string): ChatThread {
    const thread = state.threads.get(threadId);
    if (!thread) throw new Error("thread-not-found");
    return thread;
  }

  private tick(candidate?: number): number {
    if (candidate !== undefined) {
      if (!Number.isSafeInteger(candidate) || candidate < 0) throw new Error("invalid-input");
      this.clock = Math.max(this.clock, candidate + 1);
      return candidate;
    }
    return this.clock++;
  }

  private workspace(id: string): WorkspaceState {
    let state = this.workspaces.get(id);
    if (!state) {
      state = {
        channels: new Map(),
        threads: new Map(),
        messages: new Map(),
        threadMessages: new Map(),
        attachments: new Map(),
        decisions: new Map(),
        reactions: new Map(),
        mentions: [],
        agentReads: new Map(),
        humanReads: new Map(),
        humanReadStates: new Map(),
        follows: new Map(),
        followRecords: new Map(),
        feedReads: new Map(),
        bookmarks: new Map(),
        dispatches: new Map(),
        runs: new Map(),
        runLinks: new Map(),
        pauses: new Map(),
        scanHighWaterMs: -1,
      };
      this.workspaces.set(id, state);
    }
    return state;
  }
}
