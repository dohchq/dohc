import { describe, expect, it } from "vitest";
import type { ChatsNav } from "../workbench/ChatsView";
import {
  chatsNavigationChangesDestination,
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

  // Two keys, two purposes. Cancelling a pending DM lookup asks "did the user
  // go somewhere?", and a focused message is somewhere. Scoping drafts asks
  // the narrower "did they leave the conversation?", because the draft they
  // typed there must survive a jump inside it.
  it("separates leaving a conversation from going somewhere inside it", () => {
    const focused = threadNav("thread-1", "message-1");
    const otherMessage = threadNav("thread-1", "message-2");
    const otherThread = threadNav("thread-2");

    // A backlink to another message in the open thread: going somewhere...
    expect(chatsNavigationChangesDestination(focused, otherMessage)).toBe(true);
    // ...without leaving the conversation, so the draft stays.
    expect(chatsNavigationLeavesConversation(focused, otherMessage)).toBe(false);

    // Another conversation is both.
    expect(chatsNavigationChangesDestination(focused, otherThread)).toBe(true);
    expect(chatsNavigationLeavesConversation(focused, otherThread)).toBe(true);

    // The panel re-reporting where it already is, is neither.
    expect(
      chatsNavigationChangesDestination(focused, threadNav("thread-1", "message-1")),
    ).toBe(false);
    expect(chatsNavigationLeavesConversation(focused, focused)).toBe(false);
  });
});
