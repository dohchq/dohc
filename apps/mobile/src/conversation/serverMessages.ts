import { workspaceWords } from "@dohc/interface-words/workspace";
import type { ChatMessage } from "../server/workspaceReads";
import type { Author, Message } from "./sample";

// A chat's messages from the server, as the conversation draws them: under a line for each day, with a follow-up
// from the same author within 5 minutes drawn without its avatar and byline.

export type ConversationItem =
  | { readonly type: "day"; readonly key: string; readonly label: string }
  | { readonly type: "message"; readonly key: string; readonly message: Message; readonly continued: boolean; readonly afterExtras: boolean };

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * Who wrote a message. Its ID is the author's kind and display name, so a person and an agent that share a name are
 * two authors. The server keeps no colour for a person, so their mark takes a fill by their name, the same in every
 * chat.
 */
function author(entry: ChatMessage, fills: readonly string[]): Author {
  const id = `${entry.authorKind}:${entry.authorName}`;
  if (entry.authorKind === "agent") return { id, name: entry.authorName, kind: "agent" };
  const hash = [...entry.authorName].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 0);
  const initials = entry.authorName.split(/\s+/).filter(Boolean).slice(0, 2).map(word => [...word][0]?.toUpperCase() ?? "").join("");
  return { id, name: entry.authorName, kind: "person", initials, hue: fills[hash % fills.length] };
}

export function serverMessage(entry: ChatMessage, replies: { count: number; lastMs: number } | null, fills: readonly string[]): Message {
  return {
    id: entry.id, threadId: entry.threadId, author: author(entry, fills), at: timeOf(entry.createdAtMs), minute: Math.floor(entry.createdAtMs / 60_000),
    body: [{ text: entry.body }],
    ...(replies ? { replies: { count: replies.count, last: timeOf(replies.lastMs), people: [] } } : {}),
  };
}

const dayKey = (ms: number) => new Date(ms).toDateString();

/**
 * Whether a message continues the one before it, as the desktop's continuesRun decides: the same day, the same kind
 * of author with the same name, which the author's ID holds in that order, and within 5 minutes.
 */
export function continuesRun(previous: Message | undefined, entry: Message): boolean {
  return previous !== undefined && dayKey(previous.minute * 60_000) === dayKey(entry.minute * 60_000) &&
    previous.author.kind === entry.author.kind && previous.author.id === entry.author.id && entry.minute - previous.minute <= 5;
}

export function conversationItems(messages: readonly Message[], nowMs: number): ConversationItem[] {
  const today = dayKey(nowMs);
  const yesterday = dayKey(nowMs - 86_400_000);
  const items: ConversationItem[] = [];
  let day: string | null = null;
  for (const [index, entry] of messages.entries()) {
    const at = entry.minute * 60_000;
    const key = dayKey(at);
    if (key !== day) {
      day = key;
      const label = key === today ? workspaceWords.today : key === yesterday ? workspaceWords.yesterday
        : new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      items.push({ type: "day", key: `day:${key}`, label });
    }
    const previous = index > 0 ? messages[index - 1] : undefined;
    // A follow-up after a thread link sits a little further away, so it doesn't read as part of it.
    items.push({ type: "message", key: entry.id, message: entry, continued: continuesRun(previous, entry), afterExtras: previous?.replies !== undefined });
  }
  return items;
}
