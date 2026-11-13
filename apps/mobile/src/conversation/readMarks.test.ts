import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../server/workspaceReads";
import { markShown, markShownPosts } from "./readMarks";

// A screen marks the newest message of each thread it shows, in the engine's order, and each unread post it shows up to
// the post's own message, only while the person can see it.

const message = (id: string, threadId: string, createdAtMs: number): ChatMessage => ({
  id,
  threadId,
  authorKind: "human",
  authorName: "Maya Chen",
  body: "",
  createdAtMs,
  parentMessageId: null,
  attachments: [],
  needsDecision: false,
  decisionState: null,
  options: [],
  chosenOption: null,
  resolvedByMessageId: null,
  reactions: [],
});

function recorder() {
  const marks: Array<[threadId: string, messageId: string]> = [];
  return {
    marks,
    data: {
      markRead: (threadId: string, messageId: string) => void marks.push([threadId, messageId]),
    },
  };
}

describe("a screen's read marks", () => {
  it("mark each thread's newest message shown", () => {
    const { marks, data } = recorder();
    markShown(
      data,
      [
        message("message-1", "thread-a", 1),
        message("message-3", "thread-b", 3),
        message("message-2", "thread-a", 2),
      ],
      true,
    );
    expect(marks).toEqual([
      ["thread-a", "message-2"],
      ["thread-b", "message-3"],
    ]);
  });

  it("break a tie in time by code point, as the engine's byte order does", () => {
    for (const [earlier, later] of [
      ["message-", "message-\u{10000}"],
      ["message-", "message-\u{10000}"],
    ] as const) {
      for (const shown of [
        [message(earlier, "thread-a", 5), message(later, "thread-a", 5)],
        [message(later, "thread-a", 5), message(earlier, "thread-a", 5)],
      ]) {
        const { marks, data } = recorder();
        markShown(data, shown, true);
        expect(marks, JSON.stringify(later)).toEqual([["thread-a", later]]);
      }
    }
  });

  it("mark nothing while another screen covers this one, and the newest message once it shows again", () => {
    const { marks, data } = recorder();
    const before = [message("message-1", "thread-a", 1)];
    markShown(data, before, true);
    // A thread opens over the stream, and the stream's refresh brings a new message.
    const after = [...before, message("message-2", "thread-a", 2)];
    markShown(data, after, false);
    expect(marks).toEqual([["thread-a", "message-1"]]);
    // Back on the stream.
    markShown(data, after, true);
    expect(marks).toEqual([
      ["thread-a", "message-1"],
      ["thread-a", "message-2"],
    ]);
  });

  it("mark nothing without a store or messages", () => {
    const { marks, data } = recorder();
    markShown(null, [message("message-1", "thread-a", 1)], true);
    markShown(data, null, true);
    expect(marks).toEqual([]);
  });
});

describe("a stream's posts", () => {
  it("mark an unread post up to its own message, even with no replies to open, and leave read posts alone", () => {
    const { marks, data } = recorder();
    // The post in thread-a has no replies; the chat list counts it unread. The post in thread-b is read.
    const posts = [message("message-a", "thread-a", 1), message("message-b", "thread-b", 2)];
    markShownPosts(data, posts, new Set(["thread-a"]), true);
    expect(marks).toEqual([["thread-a", "message-a"]]);
  });

  it("mark nothing while covered, or before the chat list's counts are read", () => {
    const { marks, data } = recorder();
    const posts = [message("message-a", "thread-a", 1)];
    markShownPosts(data, posts, new Set(["thread-a"]), false);
    markShownPosts(data, posts, null, true);
    expect(marks).toEqual([]);
  });
});
