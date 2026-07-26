import { describe, expect, it } from "vitest";
import {
  ChatsProtocolShapeError,
  WorkspaceProtocolShapeError,
  decodeGranularChatMessageSearchResults,
  decodeUnreadFileThreads,
} from "./index";

describe("CLI daemon read decoders", () => {
  it("decodes granular chat candidates including the null thread-header id", () => {
    expect(
      decodeGranularChatMessageSearchResults([
        {
          threadId: "thread-1",
          messageId: null,
          text: "Thread title",
        },
        {
          threadId: "thread-1",
          messageId: "message-1",
          text: "Message body",
        },
      ]),
    ).toEqual([
      { threadId: "thread-1", messageId: null, text: "Thread title" },
      {
        threadId: "thread-1",
        messageId: "message-1",
        text: "Message body",
      },
    ]);
  });

  it("fails granular candidates closed on unknown or malformed fields", () => {
    expect(() =>
      decodeGranularChatMessageSearchResults([
        {
          threadId: "thread-1",
          messageId: 1,
          text: "bad",
        },
      ]),
    ).toThrow(WorkspaceProtocolShapeError);
    expect(() =>
      decodeGranularChatMessageSearchResults([
        {
          threadId: "",
          messageId: null,
          text: "bad",
        },
      ]),
    ).toThrow(WorkspaceProtocolShapeError);
    expect(() =>
      decodeGranularChatMessageSearchResults([
        {
          threadId: "thread-1",
          messageId: null,
          text: "bad",
          extra: true,
        },
      ]),
    ).toThrow(WorkspaceProtocolShapeError);
  });

  it("decodes unread file-thread aggregates", () => {
    expect(
      decodeUnreadFileThreads([
        {
          threadId: "thread-1",
          messageCount: 2,
          lastReadSequence: 1,
        },
      ]),
    ).toEqual([
      {
        threadId: "thread-1",
        messageCount: 2,
        lastReadSequence: 1,
      },
    ]);
  });

  it("fails unread aggregates closed on unsafe, negative, or extra data", () => {
    for (const row of [
      {
        threadId: "",
        messageCount: 1,
        lastReadSequence: 0,
      },
      {
        threadId: "thread-1",
        messageCount: Number.MAX_SAFE_INTEGER + 1,
        lastReadSequence: 0,
      },
      {
        threadId: "thread-1",
        messageCount: 1,
        lastReadSequence: -1,
      },
      {
        threadId: "thread-1",
        messageCount: 1,
        lastReadSequence: 0,
        extra: true,
      },
    ]) {
      expect(() => decodeUnreadFileThreads([row])).toThrow(
        ChatsProtocolShapeError,
      );
    }
  });
});
