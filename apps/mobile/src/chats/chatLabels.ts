import { agentCardWords } from "./agentCard";
import type { ChatKind, ChatRowData } from "./sample";

// The DL's words for a chat's header (Nov 7, from desktop #3408 at dbd07864a). The header shows no reported text: the
// claim is on the agent's card, with its "(as reported)".
export const chatWords = { connectedAgent: agentCardWords.connected, unnamedAgent: agentCardWords.unnamed } as const;

/** A chat's shown name: "#" marks a group only, as on the desktop; a file's chat, a person or an agent goes by its name,
 * and an agent that gave no name is "Agent". */
export function chatTitle(kind: ChatKind, name: string): string {
  if (kind === "agent" && name.trim() === "") return chatWords.unnamedAgent;
  return kind === "group" ? `#${name}` : name;
}

/** The header's second line: the member count for a group or a file's chat; "Connected agent" for a chat with one
 * connected agent; nothing for a chat with one person or with your own agent. */
export function chatSubtitle(chat: Pick<ChatRowData, "kind" | "connected">, members: number): string | undefined {
  if (chat.kind === "agent") return chat.connected ? chatWords.connectedAgent : undefined;
  if (chat.kind === "person") return undefined;
  return `${members} members`;
}

/** An unread count as the desktop shows it: past 99 it says 99+. */
export function countText(count: number): string {
  return count > 99 ? "99+" : String(count);
}
