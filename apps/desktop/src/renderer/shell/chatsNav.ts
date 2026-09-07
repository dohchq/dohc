import type { ChatsNav } from "../workbench/ChatsView";

function chatsDestinationKey(nav: ChatsNav | null): string {
  if (!nav) return "channels";
  if (nav.level === "channel") return `channel:${nav.channel.id}`;
  if (nav.level === "thread") return `thread:${nav.thread.id}`;
  if (nav.level === "dm") return `dm:${nav.dm.channelId}`;
  return nav.level;
}

function chatsFocusMessageId(nav: ChatsNav | null): string | undefined {
  return nav && (nav.level === "thread" || nav.level === "dm")
    ? nav.focusMessageId
    : undefined;
}

// Two questions about one navigation, deliberately different.
//
// Did the user leave the conversation? That scopes drafts: a draft belongs to
// the conversation it was typed in, so a jump within that conversation must
// not discard it.
export function chatsNavigationLeavesConversation(
  current: ChatsNav | null,
  next: ChatsNav,
): boolean {
  return chatsDestinationKey(current) !== chatsDestinationKey(next);
}

// Did the user GO somewhere? That cancels a pending DM lookup. A focused
// message IS somewhere — chatsNavigationRequiresRemount treats it as a new
// jump for exactly that reason — so a backlink or feed item landing on another
// message in the open conversation counts, even though the conversation did
// not change and the draft typed there survives.
export function chatsNavigationChangesDestination(
  current: ChatsNav | null,
  next: ChatsNav,
): boolean {
  return (
    chatsNavigationLeavesConversation(current, next) ||
    chatsFocusMessageId(current) !== chatsFocusMessageId(next)
  );
}

export function chatsNavigationRequiresRemount(
  current: ChatsNav | null,
  next: ChatsNav,
): boolean {
  if (chatsDestinationKey(current) !== chatsDestinationKey(next)) return true;
  // Message backlinks are commands, not durable conversation identity. Even
  // when the destination thread is already live, remount it with the new
  // focus target so ChatsView gets another chance to scroll (and so clicking
  // the same backlink twice remains useful after the user has scrolled away).
  return (
    (next.level === "thread" || next.level === "dm") &&
    Boolean(next.focusMessageId)
  );
}
