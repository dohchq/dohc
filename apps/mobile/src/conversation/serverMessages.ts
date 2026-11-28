import { workspaceWords } from "@dohc/interface-words/workspace";
import { chatMentions } from "@dohc/workspace-contracts/chat-mentions";
import { chatWords } from "@dohc/interface-words/notices";
import { accountDisplayNameOf } from "@dohc/security-contract/share-discussion";
import { accountAuthorName } from "@dohc/workspace-contracts/names";
import type { ChatMessage } from "../server/workspaceReads";
import { decisionOf } from "./decisionAnswers";
import type { PhoneMention } from "./mentionDraft";
import type { LocalRow } from "./outboxMessages";
import type { Author, Message, Segment } from "./types";

// A chat's messages from the server, as the conversation draws them: under a line for each day, with a follow-up
// from the same author within 5 minutes drawn without its avatar and byline.

export type ConversationItem =
  | { readonly type: "day"; readonly key: string; readonly label: string }
  | {
      readonly type: "message";
      readonly key: string;
      readonly message: Message;
      readonly continued: boolean;
      readonly afterExtras: boolean;
    };

let formatOffset = Number.NaN;
let timeFormat: Intl.DateTimeFormat;
let dayFormat: Intl.DateTimeFormat;
function ensureFormats() {
  const offset = new Date().getTimezoneOffset();
  if (offset === formatOffset) return;
  formatOffset = offset;
  timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
}
const timeOf = (ms: number) => {
  ensureFormats();
  return timeFormat.format(ms);
};

/**
 * Who wrote a message. Its ID is the author's kind and display name, so a person and an agent that share a name are
 * two authors. The server keeps no colour for a person, so their mark takes a fill by their name, the same in every
 * chat.
 */
function author(entry: ChatMessage, fills: readonly string[]): Author {
  const id = `${entry.authorKind}:${entry.authorName}`;
  if (entry.authorKind === "agent") return { id, name: entry.authorName, kind: "agent" };
  return personAuthor(id, entry.authorName, fills);
}

/** A person by name, with their initials and the fill their name takes in every chat. */
export function personAuthor(id: string, name: string, fills: readonly string[]): Author {
  const hash = [...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 0);
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0]?.toUpperCase() ?? "")
    .join("");
  return { id, name, kind: "person", initials, hue: fills[hash % fills.length] };
}

/**
 * The author of a message only this phone has: the account, by the name the server will give the message, from its
 * name as the server has it (`SignIn.accountName`). Until that name is read, `accountName` is undefined and it's You.
 */
export const localAuthor = (
  accountName: string | null | undefined,
  fills: readonly string[],
): Author =>
  personAuthor(
    "local:you",
    accountName === undefined
      ? chatWords.you
      : accountAuthorName(accountDisplayNameOf(accountName)),
    fills,
  );

/** A message from the server, with its question or poll as the server has it. */
export function serverMessage(
  entry: ChatMessage,
  replies: { count: number; lastMs: number } | null,
  fills: readonly string[],
): Message {
  const decision = decisionOf(entry);
  return {
    id: entry.id,
    threadId: entry.threadId,
    author: author(entry, fills),
    at: timeOf(entry.createdAtMs),
    minute: Math.floor(entry.createdAtMs / 60_000),
    body: [{ text: entry.body }],
    ...(replies
      ? { replies: { count: replies.count, last: timeOf(replies.lastMs), people: [] } }
      : {}),
    ...(decision ? { decision } : {}),
  };
}

/**
 * A post, message or reply only this phone has, by `you`. Its ID is the one the server will give it, so the row keeps
 * its place when a read brings the server's. It has no time of its own: its state shows in the time's place.
 */
export function localMessage(row: LocalRow, you: Author): Message {
  return {
    id: row.messageId,
    author: you,
    at: "",
    minute: 0,
    ...(row.title ? { title: row.title } : {}),
    body: [{ text: row.mark.body }],
    local: row.mark,
    ...(row.replyable
      ? {
          replyable: {
            operationId: row.mark.operationId,
            messageId: row.messageId,
            threadId: row.threadId,
          },
        }
      : {}),
  };
}

/** `body` with each `@handle` that names one of `candidates` drawn as a mention, as the desktop's chat draws it. */
export function mentionSegments(body: string, candidates: readonly PhoneMention[]): Segment[] {
  const segments: Segment[] = [];
  let at = 0;
  for (const { start, end, candidate } of chatMentions(body, candidates)) {
    if (start > at) segments.push({ text: body.slice(at, start) });
    segments.push({
      mention: body.slice(start + 1, end),
      ...(candidate.kind === "agent" ? { agent: true } : {}),
    });
    at = end;
  }
  if (at < body.length || segments.length === 0) segments.push({ text: body.slice(at) });
  return segments;
}

/** The message with its mentions of `candidates` drawn, or the same message when its text names none. */
export function withMentions(message: Message, candidates: readonly PhoneMention[]): Message {
  const [only] = message.body;
  if (message.body.length !== 1 || only === undefined || !("text" in only)) return message;
  const body = mentionSegments(only.text, candidates);
  return body.some((segment) => "mention" in segment) ? { ...message, body } : message;
}

const dayKey = (ms: number) => {
  const date = new Date(ms);
  return date.getFullYear() * 10_000 + date.getMonth() * 100 + date.getDate();
};

const sameRun = (previous: Message, entry: Message) =>
  previous.author.kind === entry.author.kind &&
  previous.author.id === entry.author.id &&
  entry.minute - previous.minute <= 5;

/**
 * Whether a message continues the one before it, as the desktop's continuesRun decides: the same day, the same kind
 * of author with the same name, which the author's ID holds in that order, and within 5 minutes.
 */
export function continuesRun(previous: Message | undefined, entry: Message): boolean {
  return (
    previous !== undefined &&
    dayKey(previous.minute * 60_000) === dayKey(entry.minute * 60_000) &&
    sameRun(previous, entry)
  );
}

/** The server's messages under their days, then the messages only this phone has, each with its own byline. */
export function conversationItems(
  messages: readonly Message[],
  nowMs: number,
  local: readonly Message[] = [],
): ConversationItem[] {
  const today = dayKey(nowMs);
  const yesterday = dayKey(nowMs - 86_400_000);
  ensureFormats();
  const items: ConversationItem[] = [];
  let day: number | null = null;
  let previousDay: number | null = null;
  for (const [index, entry] of messages.entries()) {
    const at = entry.minute * 60_000;
    const key = dayKey(at);
    if (key !== day) {
      day = key;
      const label =
        key === today
          ? workspaceWords.today
          : key === yesterday
            ? workspaceWords.yesterday
            : dayFormat.format(at);
      items.push({ type: "day", key: `day:${key}`, label });
    }
    const previous = index > 0 ? messages[index - 1] : undefined;
    // A follow-up after a thread link sits a little further away, so it doesn't read as part of it.
    items.push({
      type: "message",
      key: entry.id,
      message: entry,
      continued: previous !== undefined && previousDay === key && sameRun(previous, entry),
      afterExtras: previous?.replies !== undefined,
    });
    previousDay = key;
  }
  for (const [index, entry] of local.entries()) {
    const previous = index > 0 ? local[index - 1] : messages[messages.length - 1];
    items.push({
      type: "message",
      key: entry.id,
      message: entry,
      continued: false,
      afterExtras: previous?.replies !== undefined,
    });
  }
  return items;
}
