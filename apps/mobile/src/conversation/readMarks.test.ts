import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../server/workspaceReads";
import { markShown, markShownPosts, shownMessages } from "./readMarks";

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
    const after = [...before, message("message-2", "thread-a", 2)];
    markShown(data, after, false);
    expect(marks).toEqual([["thread-a", "message-1"]]);
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

describe("a thread opened at a message", () => {
  const thread = [
    message("message-1", "thread-a", 1),
    message("message-2", "thread-a", 2),
    message("message-3", "thread-a", 3),
    message("message-4", "thread-a", 4),
  ];

  it("is read through its anchor while the newer messages stay below the screen", () => {
    const { marks, data } = recorder();
    markShown(data, shownMessages(thread, "message-2", new Set()), true);
    markShown(data, shownMessages(thread, "message-2", new Set(["message-1", "message-2"])), true);
    expect(marks).toEqual([
      ["thread-a", "message-2"],
      ["thread-a", "message-2"],
    ]);
  });

  it("is read through each newer message as it comes on screen, and not back when the person scrolls up", () => {
    const { marks, data } = recorder();
    const onScreen = new Set(["message-2", "message-3"]);
    markShown(data, shownMessages(thread, "message-2", onScreen), true);
    onScreen.add("message-1");
    markShown(data, shownMessages(thread, "message-2", onScreen), true);
    expect(marks).toEqual([
      ["thread-a", "message-3"],
      ["thread-a", "message-3"],
    ]);
  });

  it("is read through a message that arrives while the person is at the end, once it comes on screen", () => {
    const { marks, data } = recorder();
    const onScreen = new Set(["message-3", "message-4"]);
    const arrived = [...thread, message("message-5", "thread-a", 5)];
    markShown(data, shownMessages(arrived, "message-2", onScreen), true);
    onScreen.add("message-5");
    markShown(data, shownMessages(arrived, "message-2", onScreen), true);
    expect(marks).toEqual([
      ["thread-a", "message-4"],
      ["thread-a", "message-5"],
    ]);
  });

  it("is read through its newest message without an anchor, or with one it lacks", () => {
    for (const anchor of [null, "message-9"]) {
      const { marks, data } = recorder();
      markShown(data, shownMessages(thread, anchor, new Set()), true);
      expect(marks, String(anchor)).toEqual([["thread-a", "message-4"]]);
    }
  });
});

describe("a stream's posts", () => {
  it("mark an unread post up to its own message, even with no replies to open, and leave read posts alone", () => {
    const { marks, data } = recorder();
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
