import { chatTabPath } from "../workbench/workbenchState";
import type { ChatsNav } from "../workbench/ChatsView";
import { agentChatIdentity, type SettingsAgent } from "../workbench/agentChat";

function chatsDestinationKey(nav: ChatsNav | null): string {
  if (!nav) return "channels";
  if (nav.level === "channel") return `channel:${nav.channel.id}`;
  if (nav.level === "thread") return `thread:${nav.thread.id}`;
  if (nav.level === "direct") return `direct:${nav.conversationId}`;
  return nav.level;
}

// Drafts follow the conversation, including jumps between its messages.
export function chatsNavigationLeavesConversation(
  current: ChatsNav | null,
  next: ChatsNav,
): boolean {
  return chatsDestinationKey(current) !== chatsDestinationKey(next);
}

export function chatsNavigationRequiresRemount(current: ChatsNav | null, next: ChatsNav): boolean {
  if (chatsDestinationKey(current) !== chatsDestinationKey(next)) return true;
  // Message backlinks are commands, not durable conversation identity. Even
  // when the destination thread is already live, remount it with the new
  // focus target so ChatsView gets another chance to scroll (and so clicking
  // the same backlink twice remains useful after the user has scrolled away).
  // Naming a channel's chat lane is a command too.
  if (next.level === "channel") return Boolean(next.focusMessageId || next.lane);
  if (next.level === "thread") return Boolean(next.focusMessageId);
  // New message from a member's row names who to message.
  return next.level === "direct-new" && next.memberId !== undefined;
}

// Thread navigation stays within its channel, so the tab keeps that name.
// An agent's chat takes its own agent's name. A group's tab draws its "#",
// so the name goes without one.
export function chatEditorTitle(nav: ChatsNav | null, agents: readonly SettingsAgent[]): string {
  if (!nav || nav.level === "feed") return "Home";
  if (nav.level === "channel" || nav.level === "thread") {
    return nav.channel.kind === "agent"
      ? agentChatIdentity(nav.channel, agents).label
      : nav.channel.name;
  }
  if (nav.level === "direct") return nav.title ?? "Direct message";
  return nav.level === "direct-new" ? "New message" : "Chats";
}

export function chatEditorPath(nav: ChatsNav): string {
  if (nav.level === "channel" || nav.level === "thread") {
    return chatTabPath({ kind: "channel", id: nav.channel.id });
  }
  if (nav.level === "direct") return chatTabPath({ kind: "dm", id: nav.conversationId });
  return chatTabPath({ kind: nav.level === "direct-new" ? "new" : "home" });
}
