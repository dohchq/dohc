import { isRecord } from "@dohc/workspace-core/records";

// Direct messages: the wire contract between the relay, the desktop app, and
// the browser. A conversation belongs to a set of accounts on one relay, not
// to a workspace. The relay is the only authority; a reader treats a response
// these checks refuse as unreadable, never as a narrower answer.
//
// See docs/engineering/plans/workspace-members.md, "Chats".

/** The most people in one conversation, the sender included. */
export const MAX_DIRECT_PEOPLE = 8;
/** The longest message body, in UTF-8 bytes. */
export const DIRECT_MESSAGE_BODY_MAX_BYTES = 16_384;
/** The longest preview of a conversation's last message, in code points. */
export const DIRECT_PREVIEW_MAX_CHARS = 200;
/** The most messages one page returns. */
export const DIRECT_PAGE_MAX = 200;
/** The longest a direct activity request waits for a change. */
export const DIRECT_ACTIVITY_MAX_WAIT_MS = 25_000;

const ID = /^[A-Za-z0-9_-]{1,128}$/u;
export function isDirectId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

/** An account id as the relay holds it: printable, no spaces, at most 256 characters. */
export function isDirectPersonId(value: unknown): value is string {
  return typeof value === "string" && /^[!-~]{1,256}$/u.test(value);
}

/** A person picked from a workspace's member list. `memberId` is `"owner"` for the owner. */
export interface DirectMemberPick {
  workspaceId: string;
  memberId: string;
}

/** Another person in a conversation. `personId` is their account id on this relay. */
export interface DirectPerson {
  personId: string;
  /** The account's name. Null when the account has none, or no longer exists. */
  name: string | null;
  /** True when the viewer blocks this person. */
  blocked: boolean;
}

export interface DirectMessage {
  seq: number;
  messageId: string;
  authorId: string;
  authorName: string | null;
  body: string;
  createdAtMs: number;
}

export interface DirectConversation {
  conversationId: string;
  /** Everyone in the conversation except the viewer. */
  people: DirectPerson[];
  /** The newest message the viewer can read, its body cut to a preview. Null when every message is hidden from them. */
  last: DirectMessage | null;
  /** Messages from other people after the viewer's read mark. */
  unread: number;
  /** True when the viewer blocks the only other person. */
  blocked: boolean;
}

export interface DirectConversationList {
  revision: number;
  conversations: DirectConversation[];
}

export interface DirectMessagePage {
  conversationId: string;
  messages: DirectMessage[];
  /** True when older messages exist before the first one returned. */
  more: boolean;
}

/** What `resolve` answers: the conversation the people already have, or null when none exists yet. */
export interface DirectResolution {
  conversationId: string | null;
  people: DirectPerson[];
}

export interface DirectSendResult {
  conversationId: string;
  seq: number;
}

/** The relay paths. `:conversationId` is a URL path segment. */
export const DIRECT_ROUTES = {
  /** GET → DirectConversationList. */
  conversations: "/sync/direct/conversations",
  /** POST {people: DirectMemberPick[]} → DirectResolution. */
  resolve: "/sync/direct/resolve",
  /** POST {conversationId} or {people}, plus {messageId, body} → DirectSendResult. Creates the conversation with its first message. */
  send: "/sync/direct/send",
  /** GET ?after=&before=&limit= → DirectMessagePage. */
  messages: "/sync/direct/conversations/:conversationId/messages",
  /** POST {seq} → {ok}. */
  read: "/sync/direct/conversations/:conversationId/read",
  /** POST {personId, blocked} → {ok}. The person must share the conversation. */
  block: "/sync/direct/conversations/:conversationId/block",
  /** GET ?since=&waitMs= → {revision}. Answers once the account's revision passes `since`, or when the wait ends. */
  activity: "/sync/direct/activity",
} as const;

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isName = (value: unknown): value is string | null => value === null || (typeof value === "string" && value.length > 0 && value.length <= 200);

export function parseDirectPerson(value: unknown): DirectPerson | null {
  if (!isRecord(value) || !isDirectPersonId(value.personId) || !isName(value.name) || typeof value.blocked !== "boolean") return null;
  return { personId: value.personId, name: value.name, blocked: value.blocked };
}

export function parseDirectMessage(value: unknown): DirectMessage | null {
  if (!isRecord(value) || !isCount(value.seq) || value.seq < 1 || !isDirectId(value.messageId) || !isDirectPersonId(value.authorId)
    || !isName(value.authorName) || typeof value.body !== "string" || !isCount(value.createdAtMs)) return null;
  return { seq: value.seq, messageId: value.messageId, authorId: value.authorId, authorName: value.authorName, body: value.body, createdAtMs: value.createdAtMs };
}

function parseAll<T>(value: unknown, parse: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: T[] = [];
  for (const entry of value) {
    const one = parse(entry);
    if (one === null) return null;
    parsed.push(one);
  }
  return parsed;
}

export function parseDirectConversation(value: unknown): DirectConversation | null {
  if (!isRecord(value) || !isDirectId(value.conversationId) || !isCount(value.unread) || typeof value.blocked !== "boolean") return null;
  const people = parseAll(value.people, parseDirectPerson);
  const last = value.last === null ? null : parseDirectMessage(value.last);
  if (!people || people.length === 0 || people.length >= MAX_DIRECT_PEOPLE || (value.last !== null && last === null)) return null;
  return { conversationId: value.conversationId, people, last, unread: value.unread, blocked: value.blocked };
}

export function parseDirectConversationList(value: unknown): DirectConversationList | null {
  if (!isRecord(value) || !isCount(value.revision)) return null;
  const conversations = parseAll(value.conversations, parseDirectConversation);
  return conversations ? { revision: value.revision, conversations } : null;
}

export function parseDirectMessagePage(value: unknown): DirectMessagePage | null {
  if (!isRecord(value) || !isDirectId(value.conversationId) || typeof value.more !== "boolean") return null;
  const messages = parseAll(value.messages, parseDirectMessage);
  return messages ? { conversationId: value.conversationId, messages, more: value.more } : null;
}

export function parseDirectResolution(value: unknown): DirectResolution | null {
  if (!isRecord(value) || !(value.conversationId === null || isDirectId(value.conversationId))) return null;
  const people = parseAll(value.people, parseDirectPerson);
  return people && people.length > 0 ? { conversationId: value.conversationId, people } : null;
}

export function parseDirectSendResult(value: unknown): DirectSendResult | null {
  if (!isRecord(value) || !isDirectId(value.conversationId) || !isCount(value.seq) || value.seq < 1) return null;
  return { conversationId: value.conversationId, seq: value.seq };
}
