import { compareMessageOrder } from "@dohc/workspace-contracts/chat-order";
import type { WorkspaceData } from "../server/workspaceData";
import type { ChatMessage } from "../server/workspaceReads";

// What a chat or thread screen marks read: the newest message of each thread it shows, in the engine's order, and
// only while the person can see it. A screen another covers, or one in an app that isn't active, marks nothing; it
// marks again once it shows, which also sends a mark that failed.

/** Marks each thread of `messages` read at its newest message, while `visible`. */
export function markShown(data: Pick<WorkspaceData, "markRead"> | null, messages: readonly ChatMessage[] | null, visible: boolean): void {
  if (!data || !messages || !visible) return;
  const newest = new Map<string, ChatMessage>();
  for (const message of messages) {
    const known = newest.get(message.threadId);
    if (!known || compareMessageOrder(message, known) > 0) newest.set(message.threadId, message);
  }
  for (const message of newest.values()) data.markRead(message.threadId, message.id);
}
