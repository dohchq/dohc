import { describe, expect, it } from "vitest";
import { chatMentionOpenTarget, graphChatOpenTarget } from "./chatOpenTarget";

describe("targeted chat navigation", () => {
  it("keeps metadata-light file mentions and graph chats on their known file thread", () => {
    const thread = {
      id: "thread-file",
      title: "File discussion",
      createdAtMs: 10,
      updatedAtMs: 20,
    };
    const mentionTarget = chatMentionOpenTarget({
      attachment: {
        attachmentId: "attachment-1",
        messageId: "message-1",
        threadId: thread.id,
        targetKind: "file",
        objectId: "object-1",
        pathHint: "docs/plan.md",
        createdAtMs: 10,
      },
      message: {
        id: "message-1",
        threadId: thread.id,
        authorKind: "human",
        authorDisplayName: "Ice",
        body: "See the plan",
        createdAtMs: 10,
      },
      thread,
    });
    expect(mentionTarget).toEqual({
      surface: "file",
      thread,
      focusMessageId: "message-1",
    });

    expect(graphChatOpenTarget({
      path: `chat-thread:${thread.id}`,
      kind: "chat-thread",
      threadId: thread.id,
      title: thread.title,
      incoming: 1,
      outgoing: 0,
    })).toEqual({
      surface: "file",
      thread: { ...thread, createdAtMs: 0, updatedAtMs: 0 },
    });
  });

  it("keeps full channel metadata on targeted tab navigation", () => {
    const target = graphChatOpenTarget({
      path: "chat-thread:thread-channel",
      kind: "chat-thread",
      threadId: "thread-channel",
      channelId: "channel-1",
      channelName: "planning",
      channelSlug: "planning",
      channelKind: "channel",
      title: "Planning discussion",
      incoming: 1,
      outgoing: 0,
    });

    expect(target.surface).toBe("channel");
    if (target.surface === "channel") {
      expect(target.nav.level).toBe("thread");
      expect(target.nav.channel.id).toBe("channel-1");
      expect(target.nav.thread.id).toBe("thread-channel");
    }

    const mentionTarget = chatMentionOpenTarget({
      attachment: {
        attachmentId: "attachment-channel",
        messageId: "message-channel",
        threadId: "thread-channel",
        targetKind: "file",
        createdAtMs: 0,
      },
      message: {
        id: "message-channel",
        threadId: "thread-channel",
        authorKind: "agent",
        authorDisplayName: "Ice",
        body: "Updated the plan",
        createdAtMs: 0,
      },
      thread: {
        id: "thread-channel",
        title: "Planning discussion",
        createdAtMs: 0,
        updatedAtMs: 0,
      },
      channelId: "channel-1",
      channelName: "planning",
    });
    expect(mentionTarget.surface).toBe("channel");
    if (mentionTarget.surface === "channel") {
      expect(mentionTarget.nav.thread.id).toBe("thread-channel");
      expect(mentionTarget.nav.focusMessageId).toBe("message-channel");
    }
  });
});
