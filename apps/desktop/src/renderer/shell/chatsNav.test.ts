import { describe, expect, it } from "vitest";
import type { ChatsNav } from "../workbench/ChatsView";
import {
  chatsNavigationLeavesConversation,
  chatsNavigationRequiresRemount,
} from "./chatsNav";

describe("targeted chat navigation", () => {
  const threadNav = (threadId: string, focusMessageId?: string): ChatsNav => ({
    level: "thread",
    channel: {
      id: "channel-1",
      name: "general",
      slug: "general",
      kind: "channel",
      createdAtMs: 0,
      updatedAtMs: 0,
      threadCount: 1,
      unreadCount: 0,
    },
    thread: {
      id: threadId,
      channelId: "channel-1",
      title: "Discussion",
      createdAtMs: 0,
      updatedAtMs: 0,
      messageCount: 2,
      lastReadSequence: 0,
      unreadCount: 0,
    },
    ...(focusMessageId ? { focusMessageId } : {}),
  });

  it("remounts the live chat for a message backlink inside the current thread", () => {
    expect(
      chatsNavigationRequiresRemount(
        threadNav("thread-1", "message-1"),
        threadNav("thread-1", "message-2"),
      ),
    ).toBe(true);
    expect(
      chatsNavigationRequiresRemount(
        threadNav("thread-1", "message-1"),
        threadNav("thread-1"),
      ),
    ).toBe(false);
  });

  it("keeps drafts for a message jump but clears them for another conversation", () => {
    const focused = threadNav("thread-1", "message-1");
    expect(chatsNavigationLeavesConversation(focused, threadNav("thread-1", "message-2"))).toBe(false);
    expect(chatsNavigationLeavesConversation(focused, threadNav("thread-2"))).toBe(true);
    expect(chatsNavigationLeavesConversation(focused, focused)).toBe(false);
  });
});
