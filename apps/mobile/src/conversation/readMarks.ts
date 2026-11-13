import { compareMessageOrder } from "@dohc/workspace-contracts/chat-order";
import type { ChatMessage } from "../server/workspaceReads";

/** The store's mark, which the screen sends without waiting for it. */
type Marks = { markRead(threadId: string, messageId: string): void };

/** Marks each thread of `messages` read at its newest message, while `visible`. */
export function markShown(
  data: Marks | null,
  messages: readonly ChatMessage[] | null,
  visible: boolean,
): void {
  if (!data || !messages || !visible) return;
  const newest = new Map<string, ChatMessage>();
  for (const message of messages) {
    const known = newest.get(message.threadId);
    if (!known || compareMessageOrder(message, known) > 0) newest.set(message.threadId, message);
  }
  for (const message of newest.values()) data.markRead(message.threadId, message.id);
}

/**
 * Marks each post shown read up to its own message, while `visible`, for a post whose thread has an unread message by
 * the counts the chat list read. A post's replies stay as they were.
 */
export function markShownPosts(
  data: Marks | null,
  posts: readonly ChatMessage[] | null,
  unreadThreadIds: ReadonlySet<string> | null,
  visible: boolean,
): void {
  if (!data || !posts || !unreadThreadIds || !visible) return;
  for (const post of posts)
    if (unreadThreadIds.has(post.threadId)) data.markRead(post.threadId, post.id);
}
