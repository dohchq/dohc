import { compareMessageOrder } from "@dohc/workspace-contracts/chat-order";
import type { ChatMessage } from "../server/workspaceReads";

// What a chat or thread screen marks read: the newest message of each thread it shows, in the engine's order, and each
// unread post it shows up to the post's own message, never its replies, as the desktop does. It marks only while the
// person can see it. A screen another covers, or one in an app that isn't active, marks nothing; it marks again once it
// shows, which also sends a mark that failed.

/** The store's mark, which the screen sends without waiting for it. */
type Marks = { markRead(threadId: string, messageId: string): void };

/** Marks each thread of `messages` read at its newest message, while `visible`. */
export function markShown(data: Marks | null, messages: readonly ChatMessage[] | null, visible: boolean): void {
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
export function markShownPosts(data: Marks | null, posts: readonly ChatMessage[] | null,
  unreadThreadIds: ReadonlySet<string> | null, visible: boolean): void {
  if (!data || !posts || !unreadThreadIds || !visible) return;
  for (const post of posts) if (unreadThreadIds.has(post.threadId)) data.markRead(post.threadId, post.id);
}
