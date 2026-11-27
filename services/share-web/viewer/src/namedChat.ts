import { normalizeShareLabel } from "@dohc/security-contract/share-labels";
import type { PhoneChatWake } from "@dohc/workspace-contracts/chat-wakes";

// Client for share-web's named recipient chat HTTP. The README section "Named recipient chat HTTP" is the contract.
export const CHAT_PAGE_LIMIT = 50;
export const CHAT_FOLLOW_HOLD_MS = 30_000;
export const CHAT_EMPTY_PAGE_LIMIT = 20;

export type NamedChatAccess = "read-only" | "read-write";
/** A Group's lanes: a feed of posts, one running chat, or both. */
export type GroupType = "posts" | "chat" | "both";
export interface NamedChatChannel {
  shareId: string;
  userId: string;
  channelWireId: string;
  name: string | null;
  access: NamedChatAccess;
  maxPostBytes: number;
  maxBodyBytes: number;
  /** A member's Group names its lanes. */
  type?: GroupType;
}
/** A current file's Comments in a workspace share, named by the file's path. */
export interface NamedChatComments {
  shareId: string;
  userId: string;
  path: string;
  access: NamedChatAccess;
  maxPostBytes: number;
  maxBodyBytes: number;
}
export type NamedChatPlace = NamedChatChannel | NamedChatComments;
/** `body` is null when the relay left it out because it is too large for a browser response. */
export interface NamedChatMessage {
  relaySeq: number;
  messageId: string;
  threadId: string;
  authorUserId: string | null;
  authorDisplayName: string;
  authorKind: "human" | "agent" | "automation" | "link";
  authorOwnerDisplayName: string | null;
  createdAtMs: number;
  body: string | null;
  /** A link author that is an agent, signed in with the link. */
  linkAgent: boolean;
  /**
   * A named reader's message names its lane, and a chat reply names the message it answers.
   * `startsPost` marks the message that starts a post, which can load a page after the post's replies.
   */
  lane?: "posts" | "chat";
  parentMessageId?: string | null;
  startsPost?: boolean;
  /** Set on a deleted message's line, which keeps who wrote it and when and has no body. */
  deletedAtMs?: number;
}

/** A delete a follow passes. The reader replaces that message's line. */
export interface DeletedChatMessage {
  messageId: string;
  threadId: string;
  deletedAtMs: number;
}

/**
 * A new message: a new thread in the channel or on the file, or in a Group's lane. A reply names its thread,
 * and a reply in a Group's chat names the message it answers.
 */
export interface ChatPost {
  id: string;
  body: string;
  lane?: "posts" | "chat";
  threadId?: string;
  parentMessageId?: string;
}

/**
 * A failed chat request. Status 0 means no usable answer arrived, so a post's outcome is unknown.
 * `reason` is share-web's sentence for a refusal the reader can act on.
 */
export class NamedChatError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null = null,
    readonly reason: string | null = null,
  ) {
    super(`Named chat request failed (${status})`);
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = () => new NamedChatError(0);

export async function chatRequest(
  path: string,
  signal: AbortSignal,
  body?: unknown,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    signal.throwIfAborted();
    throw invalid();
  }
  const json =
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json";
  const value: unknown = json
    ? await response.json().catch(() => null)
    : await response.body?.cancel().catch(() => null);
  signal.throwIfAborted();
  if (response.status === 200 && record(value)) return value;
  throw new NamedChatError(
    response.status === 200 ? 0 : response.status,
    record(value) && typeof value.code === "string" ? value.code : null,
  );
}

function cursor(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw invalid();
  return Number(value);
}

export function chatMessage(value: unknown): NamedChatMessage {
  if (
    !record(value) ||
    !["messageId", "threadId", "authorDisplayName"].every(
      (key) => typeof value[key] === "string",
    ) ||
    (value.authorUserId !== null && typeof value.authorUserId !== "string") ||
    (value.deletedAtMs !== undefined &&
      (!Number.isSafeInteger(value.deletedAtMs) ||
        value.body !== null ||
        value.bodyTooLarge !== false)) ||
    !(
      (value.bodyTooLarge === false && typeof value.body === "string") ||
      (value.bodyTooLarge === true && value.body === null) ||
      (value.deletedAtMs !== undefined && value.body === null)
    ) ||
    (value.authorKind !== "human" &&
      value.authorKind !== "agent" &&
      value.authorKind !== "automation" &&
      value.authorKind !== "link") ||
    (value.authorOwnerDisplayName !== null && typeof value.authorOwnerDisplayName !== "string") ||
    // A link holder has no account.
    (value.authorKind === "link" &&
      (value.authorUserId !== null || value.authorOwnerDisplayName !== null)) ||
    // Only a link post can come from an agent connection.
    (value.linkAgent !== undefined &&
      value.linkAgent !== false &&
      !(value.linkAgent === true && value.authorKind === "link")) ||
    !Number.isSafeInteger(value.createdAtMs) ||
    !Number.isSafeInteger(value.relaySeq) ||
    Number(value.relaySeq) <= 0 ||
    (value.lane !== undefined && value.lane !== "posts" && value.lane !== "chat") ||
    (value.parentMessageId !== undefined &&
      value.parentMessageId !== null &&
      (typeof value.parentMessageId !== "string" || value.lane !== "chat")) ||
    (value.lane !== undefined && typeof value.startsPost !== "boolean")
  )
    throw invalid();
  return {
    relaySeq: Number(value.relaySeq),
    messageId: String(value.messageId),
    threadId: String(value.threadId),
    authorUserId: value.authorUserId,
    authorDisplayName: String(value.authorDisplayName),
    authorKind: value.authorKind,
    authorOwnerDisplayName: value.authorOwnerDisplayName,
    createdAtMs: Number(value.createdAtMs),
    body: value.body,
    linkAgent: value.linkAgent === true,
    ...(value.lane === undefined
      ? {}
      : {
          lane: value.lane,
          parentMessageId: typeof value.parentMessageId === "string" ? value.parentMessageId : null,
          startsPost: value.startsPost === true,
        }),
    ...(value.deletedAtMs === undefined ? {} : { deletedAtMs: Number(value.deletedAtMs) }),
  };
}

export function deletedMessage(value: unknown): DeletedChatMessage {
  if (
    !record(value) ||
    typeof value.messageId !== "string" ||
    typeof value.threadId !== "string" ||
    !Number.isSafeInteger(value.deletedAtMs)
  )
    throw invalid();
  return {
    messageId: value.messageId,
    threadId: value.threadId,
    deletedAtMs: Number(value.deletedAtMs),
  };
}

const coordinates = (place: NamedChatPlace): Record<string, string> =>
  "path" in place
    ? { shareId: place.shareId, path: place.path }
    : { shareId: place.shareId, channelWireId: place.channelWireId };

/** The answer names the same share and channel, or the same file, that the request named. */
function answers(value: Record<string, unknown>, place: NamedChatPlace): boolean {
  return Object.entries(coordinates(place)).every(([key, expected]) => value[key] === expected);
}

function page(value: Record<string, unknown>, place: NamedChatPlace): NamedChatMessage[] {
  if (!answers(value, place) || !Array.isArray(value.messages)) throw invalid();
  return value.messages.map(chatMessage);
}

export async function openNamedChannel(
  grantId: string,
  signal: AbortSignal,
): Promise<NamedChatChannel> {
  const value = await chatRequest(
    `/api/named-chat/channels?${new URLSearchParams({ grantId })}`,
    signal,
  );
  const channel: unknown =
    Array.isArray(value.channels) && value.channels.length === 1 ? value.channels[0] : null;
  if (
    typeof value.shareId !== "string" ||
    typeof value.userId !== "string" ||
    !Number.isSafeInteger(value.maxPostBytes) ||
    Number(value.maxPostBytes) <= 0 ||
    !Number.isSafeInteger(value.maxBodyBytes) ||
    Number(value.maxBodyBytes) <= 0 ||
    !record(channel) ||
    typeof channel.channelWireId !== "string" ||
    (channel.access !== "read-only" && channel.access !== "read-write")
  )
    throw invalid();
  return {
    shareId: value.shareId,
    userId: value.userId,
    channelWireId: channel.channelWireId,
    name: normalizeShareLabel(channel.name),
    access: channel.access,
    maxPostBytes: Number(value.maxPostBytes),
    maxBodyBytes: Number(value.maxBodyBytes),
  };
}

async function readHistoryPage(
  channel: NamedChatPlace,
  before: number | null,
  signal: AbortSignal,
) {
  const query = new URLSearchParams({
    ...coordinates(channel),
    limit: String(CHAT_PAGE_LIMIT),
    ...(before === null ? {} : { before: String(before) }),
  });
  const value = await chatRequest(`/api/named-chat/messages?${query}`, signal);
  return {
    messages: page(value, channel).reverse(),
    nextCursor: cursor(value.nextCursor),
    olderCursor: value.olderCursor === null ? null : cursor(value.olderCursor),
  };
}

/**
 * History in reading order, oldest first. A page whose scanned rows hold none of this channel's messages is skipped,
 * up to `CHAT_EMPTY_PAGE_LIMIT` pages. `nextCursor` is the first page's and starts following; `olderCursor` reads further back.
 */
export async function readNamedChatHistory(
  channel: NamedChatPlace,
  before: number | null,
  signal: AbortSignal,
) {
  const first = await readHistoryPage(channel, before, signal);
  let { messages, olderCursor } = first;
  for (
    let read = 1;
    !messages.length && olderCursor !== null && read < CHAT_EMPTY_PAGE_LIMIT;
    read += 1
  )
    ({ messages, olderCursor } = await readHistoryPage(channel, olderCursor, signal));
  return { messages, nextCursor: first.nextCursor, olderCursor };
}

export async function followNamedChat(
  channel: NamedChatPlace,
  since: number,
  holdMs: number,
  signal: AbortSignal,
) {
  const query = new URLSearchParams({
    ...coordinates(channel),
    since: String(since),
    hold: String(holdMs),
    limit: String(CHAT_PAGE_LIMIT),
  });
  const value = await chatRequest(`/api/named-chat/messages?${query}`, signal);
  if (typeof value.hasMore !== "boolean" || !Array.isArray(value.deleted)) throw invalid();
  return {
    messages: page(value, channel),
    deleted: value.deleted.map(deletedMessage),
    nextCursor: cursor(value.nextCursor),
    hasMore: value.hasMore,
  };
}

/**
 * Deletes a message: the owner or an admin any message in a Group or on a file, anyone their own.
 * The relay answers not-found for every refusal.
 */
export async function deleteNamedChatMessage(
  place: NamedChatPlace,
  message: Pick<NamedChatMessage, "messageId" | "threadId">,
  signal: AbortSignal,
): Promise<DeletedChatMessage> {
  const value = await chatRequest("/api/named-chat/messages/delete", signal, {
    shareId: place.shareId,
    threadId: message.threadId,
    messageId: message.messageId,
  });
  const deleted = deletedMessage(value.deleted);
  if (
    value.shareId !== place.shareId ||
    deleted.messageId !== message.messageId ||
    deleted.threadId !== message.threadId
  )
    throw invalid();
  return deleted;
}

/** The line a deleted message leaves. */
export function deletedLine(message: NamedChatMessage, deletedAtMs: number): NamedChatMessage {
  return { ...message, body: null, linkAgent: false, deletedAtMs };
}

/** Posts a message. Retrying with the same `id` and fields returns the original message. */
export async function postNamedChatMessage(
  channel: NamedChatPlace,
  post: ChatPost,
  signal: AbortSignal,
) {
  const value = await chatRequest("/api/named-chat/messages", signal, {
    ...coordinates(channel),
    ...post,
    authorKind: "human",
  });
  if (!answers(value, channel)) throw invalid();
  return chatMessage(value.message);
}

/** Where one agent a post wakes stands, for the owner's page. */
export type ChatWake = Pick<PhoneChatWake, "wakeId" | "state" | "agentName">;

const WAKE_STATES: ReadonlySet<string> = new Set<ChatWake["state"]>([
  "held",
  "waiting",
  "claimed",
  "queued",
  "unclaimed",
  "unconfirmed",
]);

/** The wakes of the owner's own post. Only the owner's page asks; the relay refuses anyone else. */
export async function readNamedChatWakes(
  place: NamedChatPlace,
  message: Pick<NamedChatMessage, "messageId" | "threadId">,
  signal: AbortSignal,
): Promise<ChatWake[]> {
  const value = await chatRequest("/api/named-chat/wakes", signal, {
    ...coordinates(place),
    threadId: message.threadId,
    messageId: message.messageId,
  });
  if (
    !answers(value, place) ||
    value.messageId !== message.messageId ||
    !Array.isArray(value.wakes)
  )
    throw invalid();
  return value.wakes.map((wake: unknown): ChatWake => {
    if (
      !record(wake) ||
      typeof wake.wakeId !== "string" ||
      !WAKE_STATES.has(String(wake.state)) ||
      (wake.agentName !== null && typeof wake.agentName !== "string")
    )
      throw invalid();
    return {
      wakeId: wake.wakeId,
      state: wake.state as ChatWake["state"],
      agentName: wake.agentName,
    };
  });
}

/** The body the relay stores, or null when it would refuse it. */
export function normalizeChatBody(text: string, channel: NamedChatPlace): string | null {
  const body = text.replace(/\r\n?/gu, "\n").trimEnd();
  return body && body.isWellFormed() && !chatBodyTooLong(body, channel) ? body : null;
}

export function chatBodyTooLong(text: string, channel: NamedChatPlace): boolean {
  const body = text.replace(/\r\n?/gu, "\n").trimEnd(),
    encoder = new TextEncoder();
  const post = {
    ...coordinates(channel),
    id: "00000000-0000-0000-0000-000000000000",
    body,
    authorKind: "human",
  };
  return (
    encoder.encode(body).length > channel.maxBodyBytes ||
    encoder.encode(JSON.stringify(post)).length > channel.maxPostBytes
  );
}

/**
 * `deleted` holds every delete the conversation has heard, not only the
 * latest page's: an older page read before a delete still carries the text.
 */
export function mergeChatMessages(
  current: readonly NamedChatMessage[],
  incoming: readonly NamedChatMessage[],
  deleted: readonly DeletedChatMessage[],
): NamedChatMessage[] {
  // The relay sequence is unique; a message ID can match an omission marker's `omitted:<relaySeq>`.
  const bySeq = new Map(current.map((item) => [item.relaySeq, item]));
  // A page read before a delete still carries the body; the deleted line stays.
  for (const item of incoming)
    if (bySeq.get(item.relaySeq)?.deletedAtMs === undefined) bySeq.set(item.relaySeq, item);
  // A delete names the message, not its coordinate: an open follow is already past it.
  const deletedAt = new Map(
    deleted.map((entry) => [JSON.stringify([entry.threadId, entry.messageId]), entry.deletedAtMs]),
  );
  return [...bySeq.values()]
    .map((item) => {
      const at = deletedAt.get(JSON.stringify([item.threadId, item.messageId]));
      return at === undefined || item.deletedAtMs !== undefined ? item : deletedLine(item, at);
    })
    .sort((left, right) => left.relaySeq - right.relaySeq);
}
